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
  /** The active git row names the repo in argv (git -C /repo …) instead of via cwd. */
  gitArgvNamesRepo?: boolean
  lockExists?: boolean
  disappearAfterValidation?: boolean
  unlinkFailures?: number
  unlinkAlwaysFails?: boolean
  processInspectionTimesOut?: boolean
  processInspectionThrowsOn?: "ps" | "lsof"
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
    spawn(cmd) {
      processCalls.push(cmd)
      if (cmd[0] === options.processInspectionThrowsOn) {
        throw new Error(`synthetic ${cmd[0]} spawn failure`)
      }
      if (options.processInspectionTimesOut) {
        now += 100
        return Promise.resolve(processResult("", { timedOut: true }))
      }
      if (cmd[0] === "ps") {
        // Decoy rows always present: an executable merely mentioning git, and
        // a non-git process whose argv contains the repo path — neither may
        // count as an active git process.
        const rows = [
          "PID PPID COMMAND",
          "300 1 /usr/bin/legit-status git",
          `310 1 vim ${REPO_ROOT}/.git/config`,
          "100 50 bun hook",
          "50 1 zsh",
        ]
        if (options.gitArgvNamesRepo) rows.push(`200 1 git -C ${REPO_ROOT} commit`)
        else if (options.activeGit) rows.push("200 1 git commit")
        return Promise.resolve(processResult(rows.join("\n")))
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
      const psTable = [
        "PID PPID COMMAND",
        "100 50 bun hook",
        "50 1 zsh",
        ...candidatePids.map((pid) => `${pid} 1 git status`),
      ].join("\n")

      const active = await inspectGitProcessesForRepo("/repo", now + 100, {
        now: () => now,
        pid: () => 100,
        ppid: () => 50,
        spawn: (cmd, options) => {
          calls.push({ cmd, timeoutMs: options.timeoutMs })
          now += 25
          if (cmd[0] === "ps") {
            return Promise.resolve(processResult(psTable))
          }
          return Promise.resolve(processResult(""))
        },
      })

      expect(active).toBe(false)
      expect(calls).toHaveLength(2)
      expect(calls[0]?.cmd).toEqual(["ps", "-axo", "pid,ppid,command"])
      expect(calls[1]?.cmd).toEqual([
        "lsof",
        "-a",
        "-p",
        candidatePids.join(","),
        "-d",
        "cwd",
        "-Fn",
      ])
      expect(calls.map((call) => call.timeoutMs)).toEqual([100, 75])
    })

    test("detects a git -C invocation whose cwd is elsewhere, without lsof", async () => {
      const harness = createHarness({ gitArgvNamesRepo: true })
      const active = await inspectGitProcessesForRepo(REPO_ROOT, 1_100, harness.runtime)

      expect(active).toBe(true)
      expect(harness.processCalls.map((cmd) => cmd[0])).toEqual(["ps"])
    })

    test("ignores processes that merely mention git or the repo path", async () => {
      const harness = createHarness({ activeGit: false })
      const active = await inspectGitProcessesForRepo(REPO_ROOT, 1_100, harness.runtime)

      expect(active).toBe(false)
      expect(harness.processCalls.map((cmd) => cmd[0])).toEqual(["ps"])
    })

    test("detects a candidate process using the repository", async () => {
      const harness = createHarness({ activeGit: true })
      const active = await inspectGitProcessesForRepo(REPO_ROOT, 1_100, harness.runtime)

      expect(active).toBe(true)
      expect(harness.processCalls.map((cmd) => cmd[0])).toEqual(["ps", "lsof"])
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
      expect(harness.processCalls.map((cmd) => cmd[0])).toEqual(["ps", "lsof"])
    })

    test("treats an empty non-zero lsof result as a vanished candidate", async () => {
      const harness = createHarness({ activeGit: true, lsofExitCode: 1 })
      const active = await inspectGitProcessesForRepo(REPO_ROOT, 1_100, harness.runtime)

      expect(active).toBe(false)
      expect(harness.processCalls.map((cmd) => cmd[0])).toEqual(["ps", "lsof"])
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
    test("denies while a repository git process is active", async () => {
      const harness = createHarness({ activeGit: true })
      const result = await runHook("git status", harness)

      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("active git process")
      expect(result.reason).toContain("peer session")
      expect(harness.unlinkCalls()).toBe(0)
    })

    // Issue #838: the old stale-age override unlinked a live lock after 10s
    // while gitActive was true — a routine lefthook commit holds it for 30s+.
    test("never removes the lock while a git process is active, however long held", async () => {
      const harness = createHarness({ activeGit: true })
      await harness.runtime.sleep(60_000)
      const result = await runHook("git status", harness)

      expect(result.decision).toBe("deny")
      expect(harness.unlinkCalls()).toBe(0)
      expect(harness.lockExists()).toBe(true)
    })

    test("denies when process inspection cannot start", async () => {
      const harness = createHarness({ processInspectionThrowsOn: "ps" })
      const result = await runHook("git status", harness)

      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("active git process")
      expect(harness.unlinkCalls()).toBe(0)
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
            // Valid, empty process table: ps succeeded and found no git rows.
            spawn: () => Promise.resolve(processResult("PID PPID COMMAND")),
          },
        }
      )

      expect(decisionFrom(result).decision).toBe("allow")
      expect(await Bun.file(lockPath).exists()).toBe(false)
    })
  })
})
