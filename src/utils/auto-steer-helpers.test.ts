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
  getMcpChannelAvailability,
  scheduleAutoSteer,
  scheduleAutoSteerViaChannel,
} from "./auto-steer-helpers.ts"

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

async function setupAutoSteerHome(): Promise<string> {
  const home = mkdtempSync(join(tmpdir(), "swiz-autosteer-home-"))
  tmpDirs.push(home)
  process.env.HOME = home
  mkdirSync(join(home, ".swiz"), { recursive: true })
  await Bun.write(join(home, ".swiz", "settings.json"), `${JSON.stringify({ autoSteer: true })}\n`)
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

  beforeEach(async () => {
    await acquireEnvLock()
    resetAutoSteerStore()
    originalHome = process.env.HOME
    clearTerminalEnv()
  })

  afterEach(async () => {
    try {
      resetAutoSteerStore()
      if (originalHome === undefined) {
        delete process.env.HOME
      } else {
        process.env.HOME = originalHome
      }
      restoreTerminalEnv()
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

  test("scheduleAutoSteerViaChannel returns false when the MCP channel is not live", async () => {
    const home = await setupAutoSteerHome()
    const cwd = join(home, "repo")
    const projectKey = projectKeyFromCwd(cwd)
    tmpFiles.push(swizMcpChannelNotifyPath(projectKey))

    const scheduled = await scheduleAutoSteerViaChannel("session-closed", "Take the next task", cwd)

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
    expect(store.consumeOne("session-3", "next_turn")[0]?.message).toBe("Continue via terminal")
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
