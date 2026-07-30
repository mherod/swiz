import { describe, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { GIT_INDEX_LOCK } from "../src/git-helpers.ts"
import { runGit, useTempDir } from "../src/utils/test-utils.ts"
import {
  evaluatePretooluseGitIndexLock,
  type GitIndexLockRuntime,
  inspectGitProcessesForRepo,
} from "./pretooluse-git-index-lock.ts"

const REPO_ROOT = "/repo"
const GIT_DIR = `${REPO_ROOT}/.git`

interface HarnessOptions {
  activeGit?: boolean
  lockExists?: boolean
  lockOld?: boolean
  disappearAfterValidation?: boolean
  unlinkFailures?: number
  unlinkAlwaysFails?: boolean
  processInspectionTimesOut?: boolean
  processInspectionThrowsOn?: "pgrep" | "ps" | "lsof"
  lsofExitCode?: number
}

interface Harness {
  runtime: GitIndexLockRuntime
  gitCalls: string[][]
  processCalls: string[][]
  lockExists(): boolean
  unlinkCalls(): number
}

function processResult(stdout: string, options: { exitCode?: number; timedOut?: boolean } = {}) {
  return {
    stdout,
    stderr: "",
    exitCode: options.exitCode ?? 0,
    timedOut: options.timedOut ?? false,
  }
}

function createHarness(options: HarnessOptions = {}): Harness {
  let now = 1_000
  let lockExists = options.lockExists ?? true
  let fileExistsCalls = 0
  let unlinkCalls = 0
  const gitCalls: string[][] = []
  const processCalls: string[][] = []

  const runtime: GitIndexLockRuntime = {
    git(args) {
      gitCalls.push(args)
      if (args[1] === "--show-toplevel") return Promise.resolve(REPO_ROOT)
      if (args[1] === "--absolute-git-dir") return Promise.resolve(GIT_DIR)
      return Promise.resolve("")
    },
    fileExists() {
      fileExistsCalls++
      if (options.disappearAfterValidation && fileExistsCalls >= 2) {
        lockExists = false
      }
      return Promise.resolve(lockExists)
    },
    unlink() {
      unlinkCalls++
      if (options.unlinkAlwaysFails || unlinkCalls <= (options.unlinkFailures ?? 0)) {
        throw new Error("synthetic unlink failure")
      }
      lockExists = false
      return Promise.resolve()
    },
    fileMtimeMs() {
      return Promise.resolve(options.lockOld ? now - 20_000 : now)
    },
    spawn(cmd) {
      processCalls.push(cmd)
      if (cmd[0] === options.processInspectionThrowsOn) {
        throw new Error(`synthetic ${cmd[0]} spawn failure`)
      }
      if (options.processInspectionTimesOut) {
        now += 100
        return Promise.resolve(processResult("", { timedOut: true }))
      }
      if (cmd[0] === "pgrep") {
        return Promise.resolve(
          options.activeGit ? processResult("200") : processResult("", { exitCode: 1 })
        )
      }
      if (cmd[0] === "ps") {
        return Promise.resolve(processResult("PID PPID\n200 1\n100 50\n50 1"))
      }
      if (cmd[0] === "lsof") {
        if (options.lsofExitCode !== undefined) {
          return Promise.resolve(processResult("", { exitCode: options.lsofExitCode }))
        }
        return Promise.resolve(
          processResult(options.activeGit ? `p200\nn${REPO_ROOT}` : "p200\nn/other")
        )
      }
      throw new Error(`Unexpected process command: ${cmd.join(" ")}`)
    },
    sleep(ms) {
      now += ms
      return Promise.resolve()
    },
    now: () => now,
    pid: () => 100,
    ppid: () => 50,
  }

  return {
    runtime,
    gitCalls,
    processCalls,
    lockExists: () => lockExists,
    unlinkCalls: () => unlinkCalls,
  }
}

interface DecisionOutput {
  decision?: string
  reason?: string
  hookSpecificOutput?: {
    permissionDecision?: string
    permissionDecisionReason?: string
  }
}

function decisionFrom(result: DecisionOutput): { decision?: string; reason?: string } {
  return {
    decision: result.hookSpecificOutput?.permissionDecision ?? result.decision,
    reason: result.hookSpecificOutput?.permissionDecisionReason ?? result.reason,
  }
}

async function runHook(
  command: string,
  harness: Harness,
  input: { tool_name: string; tool_input: Record<string, unknown> } = {
    tool_name: "Bash",
    tool_input: { command },
  }
): Promise<{ decision?: string; reason?: string }> {
  const result = await evaluatePretooluseGitIndexLock(
    { ...input, cwd: REPO_ROOT },
    {
      lockReleaseTimeoutMs: 100,
      waitIntervalMs: 5,
      removeRetryDelayMs: 5,
      runtime: harness.runtime,
    }
  )
  return decisionFrom(result)
}

describe("pretooluse-git-index-lock", () => {
  describe("process inspection", () => {
    test("bounds process inspection and checks candidate pids in one lsof call", async () => {
      let now = 1_000
      const calls: Array<{ cmd: string[]; timeoutMs?: number }> = []
      const candidatePids = Array.from({ length: 184 }, (_, index) => index + 200)

      const active = await inspectGitProcessesForRepo("/repo", now + 100, {
        now: () => now,
        pid: () => 100,
        ppid: () => 50,
        spawn: (cmd, options) => {
          calls.push({ cmd, timeoutMs: options.timeoutMs })
          now += 25
          if (cmd[0] === "pgrep") {
            return Promise.resolve(processResult(candidatePids.join("\n")))
          }
          if (cmd[0] === "ps") {
            return Promise.resolve(processResult("PID PPID\n100 50\n50 1"))
          }
          return Promise.resolve(processResult(""))
        },
      })

      expect(active).toBe(false)
      expect(calls).toHaveLength(3)
      expect(calls[2]?.cmd).toEqual([
        "lsof",
        "-a",
        "-p",
        candidatePids.join(","),
        "-d",
        "cwd",
        "-Fn",
      ])
      expect(calls.map((call) => call.timeoutMs)).toEqual([100, 75, 50])
    })

    test("detects a candidate process using the repository", async () => {
      const harness = createHarness({ activeGit: true })
      const active = await inspectGitProcessesForRepo(REPO_ROOT, 1_100, harness.runtime)

      expect(active).toBe(true)
      expect(harness.processCalls.map((cmd) => cmd[0])).toEqual(["pgrep", "ps", "lsof"])
    })

    test("fails safe when process inspection exceeds the deadline", async () => {
      const harness = createHarness({ processInspectionTimesOut: true })
      const active = await inspectGitProcessesForRepo(REPO_ROOT, 1_100, harness.runtime)

      expect(active).toBe(true)
      expect(harness.processCalls).toHaveLength(1)
    })
    test("fails safe when a process inspection command cannot start", async () => {
      const harness = createHarness({
        activeGit: true,
        processInspectionThrowsOn: "lsof",
      })
      const active = await inspectGitProcessesForRepo(REPO_ROOT, 1_100, harness.runtime)

      expect(active).toBe(true)
      expect(harness.processCalls.map((cmd) => cmd[0])).toEqual(["pgrep", "ps", "lsof"])
    })

    test("treats an empty non-zero lsof result as a vanished candidate", async () => {
      const harness = createHarness({ activeGit: true, lsofExitCode: 1 })
      const active = await inspectGitProcessesForRepo(REPO_ROOT, 1_100, harness.runtime)

      expect(active).toBe(false)
      expect(harness.processCalls.map((cmd) => cmd[0])).toEqual(["pgrep", "ps", "lsof"])
    })
  })

  describe("stale lock resolution", () => {
    for (const command of [
      "git status",
      'git commit -m "test"',
      "git add .",
      "echo hello | git log",
    ]) {
      test(`allows ${command} after stale lock removal`, async () => {
        const harness = createHarness()
        const result = await runHook(command, harness)

        expect(result.decision).toBe("allow")
        expect(result.reason).toContain("Auto-removed")
        expect(harness.lockExists()).toBe(false)
        expect(harness.unlinkCalls()).toBe(1)
      })
    }

    test("retries a transient unlink failure", async () => {
      const harness = createHarness({ unlinkFailures: 1 })
      const result = await runHook("git status", harness)

      expect(result.decision).toBe("allow")
      expect(harness.unlinkCalls()).toBe(2)
      expect(harness.lockExists()).toBe(false)
    })

    test("denies when every unlink attempt fails", async () => {
      const harness = createHarness({ unlinkAlwaysFails: true })
      const result = await runHook("git status", harness)

      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("index.lock")
      expect(result.reason).toContain("retrying for up to")
      expect(harness.lockExists()).toBe(true)
    })

    test("allows when the lock disappears during inspection", async () => {
      const harness = createHarness({ disappearAfterValidation: true })
      const result = await runHook("git status", harness)

      expect(result.decision).toBe("allow")
      expect(result.reason).toContain("resolved automatically")
      expect(harness.unlinkCalls()).toBe(0)
    })
  })

  describe("active process handling", () => {
    test("denies a recent lock while a repository git process is active", async () => {
      const harness = createHarness({ activeGit: true })
      const result = await runHook("git status", harness)

      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("active git process")
      expect(harness.unlinkCalls()).toBe(0)
    })

    test("removes an old lock despite a matching long-lived process", async () => {
      const harness = createHarness({ activeGit: true, lockOld: true })
      const result = await runHook("git status", harness)

      expect(result.decision).toBe("allow")
      expect(result.reason).toContain("Auto-removed")
      expect(harness.lockExists()).toBe(false)
    })

    test("removes an old lock when process inspection cannot start", async () => {
      const harness = createHarness({
        activeGit: true,
        lockOld: true,
        processInspectionThrowsOn: "lsof",
      })
      const result = await runHook("git status", harness)

      expect(result.decision).toBe("allow")
      expect(result.reason).toContain("Auto-removed")
      expect(harness.lockExists()).toBe(false)
    })
    test("denies safely when process inspection times out", async () => {
      const harness = createHarness({ processInspectionTimesOut: true })
      const result = await runHook("git status", harness)

      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("active git process")
      expect(harness.unlinkCalls()).toBe(0)
    })
  })

  describe("early exits", () => {
    for (const command of ["git status", 'git commit -m "test"']) {
      test(`allows ${command} when no lock exists`, async () => {
        const harness = createHarness({ lockExists: false })
        const result = await runHook(command, harness)

        expect(result.decision).toBeUndefined()
        expect(harness.processCalls).toHaveLength(0)
      })
    }

    for (const command of ["bun test", "ls -la"]) {
      test(`passes through ${command}`, async () => {
        const harness = createHarness()
        const result = await runHook(command, harness)

        expect(result.decision).toBeUndefined()
        expect(harness.gitCalls).toHaveLength(0)
        expect(harness.processCalls).toHaveLength(0)
      })
    }

    test("passes through non-shell tools", async () => {
      const harness = createHarness()
      const result = await runHook("unused", harness, {
        tool_name: "Read",
        tool_input: { file_path: "/some/file" },
      })

      expect(result.decision).toBeUndefined()
      expect(harness.gitCalls).toHaveLength(0)
      expect(harness.processCalls).toHaveLength(0)
    })
  })

  describe("real Git contract", () => {
    const tmp = useTempDir("swiz-git-index-lock-contract-")

    test("resolves a worktree lock from the dispatching git directory", async () => {
      const parent = await tmp.create()
      const main = join(parent, "main")
      const worktree = join(parent, "worktree")
      await mkdir(main, { recursive: true })
      await runGit(main, ["init"])
      await runGit(main, [
        "-c",
        "user.name=Swiz Test",
        "-c",
        "user.email=swiz-test@example.invalid",
        "commit",
        "--allow-empty",
        "-m",
        "init",
      ])
      await runGit(main, ["worktree", "add", worktree])

      const gitDir = await runGit(worktree, ["rev-parse", "--absolute-git-dir"])
      const lockPath = join(gitDir, GIT_INDEX_LOCK)
      await Bun.write(lockPath, "")

      const result = await evaluatePretooluseGitIndexLock(
        {
          tool_name: "Bash",
          tool_input: { command: "git status" },
          cwd: worktree,
        },
        {
          lockReleaseTimeoutMs: 100,
          waitIntervalMs: 5,
          removeRetryDelayMs: 5,
          runtime: {
            spawn: () => Promise.resolve(processResult("", { exitCode: 1 })),
          },
        }
      )

      expect(decisionFrom(result).decision).toBe("allow")
      expect(await Bun.file(lockPath).exists()).toBe(false)
    })
  })
})
