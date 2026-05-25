import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getAutoSteerStore, projectKeyFromCwd, resetAutoSteerStore } from "../auto-steer-store.ts"
import {
  swizMcpChannelHeartbeatPath,
  swizMcpChannelNotifyPath,
  swizMcpChannelStatusPath,
} from "../temp-paths.ts"
import {
  clearAutoSteerHumanisationCache,
  flushAutoSteerHumanisation,
  getMcpChannelAvailability,
  humaniseAutoSteerMessage,
  renderQueuedAutoSteerRequest,
  scheduleAutoSteer,
  scheduleAutoSteerViaChannel,
} from "./auto-steer-helpers.ts"

const AI_ENV_KEYS = ["AI_TEST_NO_BACKEND", "AI_TEST_TEXT_RESPONSE", "AI_PROVIDER"] as const

const TERMINAL_ENV_KEYS = [
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
  "ITERM_SESSION_ID",
  "KITTY_WINDOW_ID",
  "ALACRITTY_LOG",
  "ALACRITTY_SOCKET",
  "WEZTERM_EXECUTABLE",
  "GHOSTTY_RESOURCES_DIR",
  "WARP_IS_LOCAL_SHELL_SESSION",
  "CURSOR_TRACE_ID",
  "VSCODE_PID",
  "VSCODE_GIT_ASKPASS_NODE",
  "WINDSURF_BIN",
  "LC_TERMINAL",
  "LC_TERMINAL_VERSION",
] as const

const originalEnv = new Map<string, string | undefined>()
const tmpDirs: string[] = []
const tmpFiles: string[] = []
let envLock: Promise<void> = Promise.resolve()
let releaseEnvLock: (() => void) | null = null

async function acquireEnvLock(): Promise<void> {
  const previous = envLock
  let release!: () => void
  envLock = new Promise<void>((resolve) => {
    release = resolve
  })
  await previous
  releaseEnvLock = release
}

function clearTerminalEnv(): void {
  for (const key of TERMINAL_ENV_KEYS) {
    originalEnv.set(key, process.env[key])
    delete process.env[key]
  }
}

function restoreTerminalEnv(): void {
  for (const key of TERMINAL_ENV_KEYS) {
    const value = originalEnv.get(key)
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
  originalEnv.clear()
}

async function setupAutoSteerHome(settings: Record<string, unknown> = {}): Promise<string> {
  const home = mkdtempSync(join(tmpdir(), "swiz-autosteer-home-"))
  tmpDirs.push(home)
  process.env.HOME = home
  mkdirSync(join(home, ".swiz"), { recursive: true })
  await Bun.write(
    join(home, ".swiz", "settings.json"),
    `${JSON.stringify({ autoSteer: true, mcpChannels: true, ...settings })}\n`
  )
  return home
}

async function writeLiveChannelStatus(cwd: string): Promise<void> {
  const projectKey = projectKeyFromCwd(cwd)
  tmpFiles.push(
    swizMcpChannelHeartbeatPath(projectKey),
    swizMcpChannelNotifyPath(projectKey),
    swizMcpChannelStatusPath(projectKey)
  )
  const now = Date.now()
  await Bun.write(swizMcpChannelHeartbeatPath(projectKey), "")
  await Bun.write(
    swizMcpChannelStatusPath(projectKey),
    `${JSON.stringify({
      projectKey,
      cwd,
      pid: 1234,
      serverName: "swiz",
      serverVersion: "0.2.0",
      connected: true,
      watcherState: "active",
      startedAt: now - 1000,
      updatedAt: now,
      deliveredCount: 0,
    })}\n`
  )
}

describe("auto-steer helpers", () => {
  let originalHome: string | undefined

  const originalAiEnv = new Map<string, string | undefined>()

  beforeEach(async () => {
    await acquireEnvLock()
    resetAutoSteerStore()
    clearAutoSteerHumanisationCache()
    originalHome = process.env.HOME
    clearTerminalEnv()
    for (const key of AI_ENV_KEYS) {
      originalAiEnv.set(key, process.env[key])
      delete process.env[key]
    }
    // Default: no AI backend so humanisation fails open to the original text,
    // keeping message assertions deterministic. Humanisation tests opt in.
    process.env.AI_TEST_NO_BACKEND = "1"
  })

  afterEach(async () => {
    try {
      // Drain any fire-and-forget humanisation before closing the store.
      await flushAutoSteerHumanisation()
      resetAutoSteerStore()
      if (originalHome === undefined) {
        delete process.env.HOME
      } else {
        process.env.HOME = originalHome
      }
      restoreTerminalEnv()
      for (const key of AI_ENV_KEYS) {
        const value = originalAiEnv.get(key)
        if (value === undefined) {
          delete process.env[key]
        } else {
          process.env[key] = value
        }
      }
      originalAiEnv.clear()
      for (const dir of tmpDirs) {
        await rm(dir, { recursive: true, force: true })
      }
      for (const file of tmpFiles) {
        await rm(file, { force: true })
      }
      tmpDirs.length = 0
      tmpFiles.length = 0
    } finally {
      releaseEnvLock?.()
      releaseEnvLock = null
    }
  })

  test("scheduleAutoSteerViaChannel does not require an AppleScript terminal", async () => {
    const home = await setupAutoSteerHome()
    const cwd = join(home, "repo")
    const projectKey = projectKeyFromCwd(cwd)
    await writeLiveChannelStatus(cwd)

    const scheduled = await scheduleAutoSteerViaChannel("session-1", "Take the next task", cwd)

    expect(scheduled).toBe(true)
    expect(existsSync(swizMcpChannelNotifyPath(projectKey))).toBe(true)
  })

  test("scheduleAutoSteerViaChannel humanises the queued message before delivery", async () => {
    const home = await setupAutoSteerHome()
    const cwd = join(home, "repo")
    const projectKey = projectKeyFromCwd(cwd)
    await writeLiveChannelStatus(cwd)
    delete process.env.AI_TEST_NO_BACKEND
    process.env.AI_TEST_TEXT_RESPONSE = "Whenever you're ready, please take the next task."

    const scheduled = await scheduleAutoSteerViaChannel("session-h-ch", "Take the next task", cwd)
    await flushAutoSteerHumanisation()

    const store = getAutoSteerStore()
    expect(scheduled).toBe(true)
    expect(store.consumeOneByProjectKey(projectKey, "next_turn")?.message).toBe(
      "Whenever you're ready, please take the next task."
    )
  })

  test("scheduleAutoSteerViaChannel leaves raw text when humaniseAutoSteer is disabled", async () => {
    const home = await setupAutoSteerHome({ humaniseAutoSteer: false })
    const cwd = join(home, "repo")
    const projectKey = projectKeyFromCwd(cwd)
    await writeLiveChannelStatus(cwd)
    delete process.env.AI_TEST_NO_BACKEND
    process.env.AI_TEST_TEXT_RESPONSE = "this rewrite must not be used"

    const scheduled = await scheduleAutoSteerViaChannel("session-noh-ch", "Take the next task", cwd)
    await flushAutoSteerHumanisation()

    const store = getAutoSteerStore()
    expect(scheduled).toBe(true)
    expect(store.consumeOneByProjectKey(projectKey, "next_turn")?.message).toBe(
      "Take the next task"
    )
  })

  test("scheduleAutoSteerViaChannel returns false when the MCP channel is not live", async () => {
    const home = await setupAutoSteerHome()
    const cwd = join(home, "repo")
    const projectKey = projectKeyFromCwd(cwd)
    tmpFiles.push(swizMcpChannelNotifyPath(projectKey))

    const scheduled = await scheduleAutoSteerViaChannel("session-closed", "Take the next task", cwd)

    expect(scheduled).toBe(false)
    expect(existsSync(swizMcpChannelNotifyPath(projectKey))).toBe(false)
  })

  test("scheduleAutoSteerViaChannel returns false when MCP channels are disabled", async () => {
    const home = await setupAutoSteerHome({ mcpChannels: false })
    const cwd = join(home, "repo")
    const projectKey = projectKeyFromCwd(cwd)
    await writeLiveChannelStatus(cwd)

    const scheduled = await scheduleAutoSteerViaChannel(
      "session-disabled",
      "Take the next task",
      cwd
    )

    expect(scheduled).toBe(false)
    expect(existsSync(swizMcpChannelNotifyPath(projectKey))).toBe(false)
  })

  test("scheduleAutoSteer uses a live MCP channel for next_turn without AppleScript", async () => {
    const home = await setupAutoSteerHome()
    const cwd = join(home, "repo")
    const projectKey = projectKeyFromCwd(cwd)
    await writeLiveChannelStatus(cwd)

    const scheduled = await scheduleAutoSteer("session-2", "Continue from swiz", "next_turn", cwd)

    expect(scheduled).toBe(true)
    expect(existsSync(swizMcpChannelNotifyPath(projectKey))).toBe(true)
  })

  test("scheduleAutoSteer asap falls back to the MCP channel without AppleScript", async () => {
    const home = await setupAutoSteerHome()
    const cwd = join(home, "repo")
    const projectKey = projectKeyFromCwd(cwd)
    await writeLiveChannelStatus(cwd)

    const scheduled = await scheduleAutoSteer("session-asap", "Handle this now", "asap", cwd)

    const store = getAutoSteerStore()
    expect(scheduled).toBe(true)
    expect(existsSync(swizMcpChannelNotifyPath(projectKey))).toBe(true)
    // No AppleScript terminal: the asap message is queued for the live channel
    // under the asap trigger rather than waiting for a dispatch.
    expect(store.consumeOneByProjectKey(projectKey, "asap")?.trigger).toBe("asap")
  })

  test("scheduleAutoSteer prefers AppleScript over a live MCP channel", async () => {
    const home = await setupAutoSteerHome()
    const cwd = join(home, "repo")
    const projectKey = projectKeyFromCwd(cwd)
    process.env.TERM_PROGRAM = "Apple_Terminal"
    await writeLiveChannelStatus(cwd)

    const scheduled = await scheduleAutoSteer(
      "session-3",
      "Continue via terminal",
      "next_turn",
      cwd
    )

    const store = getAutoSteerStore()
    expect(scheduled).toBe(true)
    expect(existsSync(swizMcpChannelNotifyPath(projectKey))).toBe(false)
    expect(store.consumeOneByProjectKey(projectKey, "next_turn")).toBeNull()
    expect(store.consumeOne("session-3", "next_turn")[0]?.message).toBe(
      "Please continue via terminal."
    )
  })

  test("humaniseAutoSteerMessage rewrites via the provider when one is available", async () => {
    delete process.env.AI_TEST_NO_BACKEND
    process.env.AI_TEST_TEXT_RESPONSE =
      "When you get a moment, could you pick up the next task on the queue?"

    const result = await humaniseAutoSteerMessage("Take the next task")

    expect(result).toBe("When you get a moment, could you pick up the next task on the queue?")
  })

  test("humaniseAutoSteerMessage uses a local paragraph rewrite when no provider is available", async () => {
    // beforeEach sets AI_TEST_NO_BACKEND=1
    const result = await humaniseAutoSteerMessage("Take the next task")

    expect(result).toBe("Please take the next task.")
  })

  test("humaniseAutoSteerMessage strips mechanical dump wording into one paragraph", async () => {
    const result = await humaniseAutoSteerMessage(
      [
        "Stop is blocked by 2 checks. Resolve them in the order shown.",
        "",
        "### git status",
        'Run `git status`, then `git add .` and `git commit -m "fix: thing"`.',
        "",
        "ACTION REQUIRED: You must act on this now. Do not try to stop again without completing the required action.",
      ].join("\n")
    )

    expect(result).not.toContain("\n")
    expect(result).not.toContain("ACTION REQUIRED")
    expect(result).toBe(
      'Please run `git status`, then `git add .` and `git commit -m "fix: thing"`.'
    )
  })

  test("humaniseAutoSteerMessage caches the promise for repeated input text", async () => {
    delete process.env.AI_TEST_NO_BACKEND
    process.env.AI_TEST_TEXT_RESPONSE = "Could you take the next task?"
    const first = await humaniseAutoSteerMessage("Take the next cached task")

    process.env.AI_TEST_TEXT_RESPONSE = "This second provider result should not be used."
    const second = await humaniseAutoSteerMessage("Take the next cached task")

    expect(first).toBe("Could you take the next task?")
    expect(second).toBe("Could you take the next task?")
  })

  test("renderQueuedAutoSteerRequest humanises raw queued rows lazily at delivery", async () => {
    await setupAutoSteerHome()
    delete process.env.AI_TEST_NO_BACKEND
    process.env.AI_TEST_TEXT_RESPONSE = "Please finish the repository checks before stopping."

    const store = getAutoSteerStore()
    const enqueued = store.enqueue("session-lazy", "Complete repository checks", "next_turn", {
      dedupKey: "Complete repository checks",
    })
    const req = store.consumeOne("session-lazy", "next_turn")[0]!
    const rendered = await renderQueuedAutoSteerRequest("session-lazy", req)

    expect(enqueued).toBe(true)
    expect(rendered).toBe("Please finish the repository checks before stopping.")
  })

  test("humaniseAutoSteerMessage returns the original for blank input", async () => {
    delete process.env.AI_TEST_NO_BACKEND
    process.env.AI_TEST_TEXT_RESPONSE = "rewritten"

    expect(await humaniseAutoSteerMessage("   ")).toBe("   ")
  })

  test("scheduleAutoSteer stores the humanised text but dedups on the original", async () => {
    const home = await setupAutoSteerHome()
    const cwd = join(home, "repo")
    process.env.TERM_PROGRAM = "Apple_Terminal"
    delete process.env.AI_TEST_NO_BACKEND
    process.env.AI_TEST_TEXT_RESPONSE = "Mind taking a look at the failing tests when you can?"

    const first = await scheduleAutoSteer("session-h", "Fix the failing tests", "next_turn", cwd)
    const second = await scheduleAutoSteer("session-h", "Fix the failing tests", "next_turn", cwd)
    // Humanisation is async/non-blocking — wait for the background rewrite to land.
    await flushAutoSteerHumanisation()

    const store = getAutoSteerStore()
    expect(first).toBe(true)
    expect(second).toBe(true)
    // Dedup keyed on the original text, so only one row is queued despite two schedules.
    expect(store.listPending("session-h")).toHaveLength(1)
    expect(store.consumeOne("session-h", "next_turn")[0]?.message).toBe(
      "Mind taking a look at the failing tests when you can?"
    )
  })

  test("scheduleAutoSteer skips humanisation when humaniseAutoSteer is disabled", async () => {
    const home = await setupAutoSteerHome({ humaniseAutoSteer: false })
    const cwd = join(home, "repo")
    process.env.TERM_PROGRAM = "Apple_Terminal"
    // A provider IS available, but the toggle is off, so the raw text must be stored.
    delete process.env.AI_TEST_NO_BACKEND
    process.env.AI_TEST_TEXT_RESPONSE = "this rewrite must not be used"

    const scheduled = await scheduleAutoSteer(
      "session-noh",
      "Fix the failing tests",
      "next_turn",
      cwd
    )
    // Even after the async path settles, the toggle-off case must leave raw text.
    await flushAutoSteerHumanisation()

    const store = getAutoSteerStore()
    expect(scheduled).toBe(true)
    expect(store.consumeOne("session-noh", "next_turn")[0]?.message).toBe("Fix the failing tests")
  })

  test("getMcpChannelAvailability explains missing status separately from heartbeat", async () => {
    const home = await setupAutoSteerHome()
    const cwd = join(home, "repo")
    const projectKey = projectKeyFromCwd(cwd)
    tmpFiles.push(swizMcpChannelHeartbeatPath(projectKey), swizMcpChannelStatusPath(projectKey))
    await Bun.write(swizMcpChannelHeartbeatPath(projectKey), "")

    const availability = getMcpChannelAvailability(cwd)

    expect(availability.available).toBe(false)
    expect(availability.reason).toBe("status-missing")
    expect(availability.heartbeatAgeMs).toBeNumber()
  })
})
