import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { join } from "node:path"
import stopGitStatus from "../../hooks/stop-git-status.ts"
import type { SwizHook } from "../SwizHook.ts"
import {
  getSwizSettingsPath,
  invalidateSettingsCache,
  readSwizSettings,
  writeSwizSettings,
} from "../settings.ts"
import * as taskIo from "../utils/session-task-io.ts"
import { acquireEnvLock, releaseEnvLockFn, useTempDir } from "../utils/test-utils.ts"
import { executeDispatch } from "./execute.ts"

const tempDirs = useTempDir("swiz-stop-auto-continue-")
let originalHome: string | undefined
let originalCapture: string | undefined
let home: string
let project: string

async function fixtureGit(...args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], { cwd: project, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  if (await proc.exited) throw new Error(`Fixture git ${args.join(" ")}: ${stderr || stdout}`)
}

async function runStopCli(): Promise<Record<string, any>> {
  const proc = Bun.spawn(
    [process.execPath, join(import.meta.dir, "../../index.ts"), "dispatch", "stop", "Stop"],
    {
      cwd: project,
      env: {
        ...process.env,
        HOME: home,
        SWIZ_DIRECT: "1",
        SWIZ_NO_DAEMON: "1",
        AI_TEST_NO_BACKEND: "1",
      },
      stdin: new Response(JSON.stringify({ cwd: project, session_id: crypto.randomUUID() })),
      stdout: "pipe",
      stderr: "pipe",
    }
  )
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  expect(await proc.exited).toBe(0)
  expect(stderr).not.toContain("Dispatch failed")
  return JSON.parse(stdout.trim())
}

beforeEach(async () => {
  await acquireEnvLock()
  originalHome = process.env.HOME
  originalCapture = process.env.SWIZ_CAPTURE_INCOMING
  home = await tempDirs.create()
  project = await tempDirs.create()
  process.env.HOME = home
  process.env.SWIZ_CAPTURE_INCOMING = "0"
})

afterEach(() => {
  const path = getSwizSettingsPath(home)
  if (path) invalidateSettingsCache(path)
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  if (originalCapture === undefined) delete process.env.SWIZ_CAPTURE_INCOMING
  else process.env.SWIZ_CAPTURE_INCOMING = originalCapture
  releaseEnvLockFn()
})

describe("git stop gate without auto-continue", () => {
  test("CLI blocks dirty work but allows stopping after committing without pushing", async () => {
    const defaults = await readSwizSettings({ home })
    await writeSwizSettings({ ...defaults, autoContinue: false, gitStatusGate: true }, { home })
    await fixtureGit("init", "-b", "main")
    await fixtureGit("config", "user.name", "Test User")
    await fixtureGit("config", "user.email", "test@example.com")
    await fixtureGit("commit", "--allow-empty", "-m", "initial")
    const remote = await tempDirs.create()
    await fixtureGit("init", "--bare", remote)
    await fixtureGit("remote", "add", "origin", remote)
    await fixtureGit("push", "-u", "origin", "main")
    await Bun.write(join(project, "uncommitted.ts"), "export const pending = true\n")

    const result = await runStopCli()
    expect(result.decision).toBe("block")
    expect(result.reason).toContain("Uncommitted changes detected")
    expect(result.reason).toContain("uncommitted.ts")
    expect(result.reason).not.toMatch(/push|pull|publish/i)

    await fixtureGit("add", "uncommitted.ts")
    await fixtureGit("commit", "-m", "local work")
    const committed = await runStopCli()
    expect(committed.decision).toBeUndefined()
    expect(committed.reason).not.toMatch(/push|pull|publish/i)

    // The same real hook retains its publish requirement when auto-continue is enabled.
    await writeSwizSettings({ ...defaults, autoContinue: true, gitStatusGate: true }, { home })
    const createTask = spyOn(taskIo, "createSessionTask").mockResolvedValue(undefined)
    try {
      const enabled = await executeDispatch({
        canonicalEvent: "stop",
        hookEventName: "Stop",
        payloadStr: JSON.stringify({ cwd: project, session_id: crypto.randomUUID() }),
        manifestProvider: async () => [{ event: "stop", hooks: [{ hook: stopGitStatus }] }],
        replayPendingMutations: async () => {},
        daemonContext: true,
      })
      expect(enabled.response.decision).toBe("block")
      expect(enabled.response.reason).toMatch(/push|publish/i)
    } finally {
      createTask.mockRestore()
    }
  })

  for (const scenario of [
    { name: "blocks dirty work with global auto-continue disabled", autoContinue: false },
    {
      name: "blocks dirty work with project auto-continue disabled",
      autoContinue: true,
      projectAutoContinue: false,
    },
    { name: "allows clean work", autoContinue: false, clean: true },
    { name: "respects a disabled git status gate", autoContinue: false, gitStatusGate: false },
    { name: "respects a disabled git status hook", autoContinue: false, disabled: true },
    { name: "retains all stop hooks when auto-continue is enabled", autoContinue: true },
    {
      name: "retains all stop hooks when the project enables auto-continue",
      autoContinue: false,
      projectAutoContinue: true,
    },
  ]) {
    test(scenario.name, async () => {
      const defaults = await readSwizSettings({ home })
      await writeSwizSettings(
        {
          ...defaults,
          autoContinue: scenario.autoContinue,
          gitStatusGate: scenario.gitStatusGate ?? true,
          disabledHooks: scenario.disabled ? ["stop-git-status.ts"] : [],
        },
        { home }
      )
      if (scenario.projectAutoContinue !== undefined) {
        await Bun.write(
          join(project, ".swiz", "config.json"),
          JSON.stringify({ autoContinue: scenario.projectAutoContinue })
        )
      }

      const ran: string[] = []
      const gitHook: SwizHook = {
        ...stopGitStatus,
        run: () => {
          ran.push("git")
          return scenario.clean
            ? {}
            : { decision: "block", reason: "Uncommitted changes detected. Run /commit." }
        },
      }
      const otherHook: SwizHook = {
        name: "test-other-stop-hook",
        event: "stop",
        run: () => {
          ran.push("other")
          return { decision: "block", reason: "Continue with another issue." }
        },
      }

      const result = await executeDispatch({
        canonicalEvent: "stop",
        hookEventName: "Stop",
        settingsHomeOverride: home,
        payloadStr: JSON.stringify({ cwd: project, session_id: crypto.randomUUID() }),
        repositoryCapabilityProvider: async () => ({
          canonicalRoot: project,
          repoKey: project,
          isRepo: true,
          repoSlug: null,
          hasGhCli: false,
          resolvedAt: Date.now(),
        }),
        manifestProvider: async () => [
          { event: "stop", hooks: [{ hook: otherHook }, { hook: gitHook }] },
        ],
        replayPendingMutations: async () => {},
        daemonContext: true,
      })

      const autoContinue = scenario.projectAutoContinue ?? scenario.autoContinue
      const gitEnabled = scenario.gitStatusGate !== false && !scenario.disabled
      expect(ran.includes("git")).toBe(gitEnabled)
      expect(ran.includes("other")).toBe(autoContinue)
      expect(result.timing.hookCount).toBe(Number(gitEnabled) + Number(autoContinue))
      if (autoContinue) {
        expect(result.response.decision).toBe("block")
        expect(result.response.reason).toContain("Continue with another issue")
      } else if (gitEnabled && !scenario.clean) {
        expect(result.response.decision).toBe("block")
        expect(result.response.reason).toContain("Uncommitted changes detected")
        expect(result.response.reason).toContain("/commit")
      } else {
        expect(result.response.decision).toBeUndefined()
        expect(result.response.continue).toBe(true)
      }
    })
  }
})
