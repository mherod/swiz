import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type AdvisoryHookResult,
  buildEffectiveTestSettings,
  buildTestSettings,
  runHookInProcess,
} from "../src/utils/test-utils.ts"
import {
  evaluatePretoolusePushChecksGate,
  type PushChecksGateDependencies,
} from "./pretooluse-push-checks-gate.ts"

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Build a transcript JSONL string containing Bash tool_use entries. Each
 *  command is prefixed by a user message so it counts as its own turn (turns
 *  are bounded by user/human entries, not raw JSONL lines). */
function makeTranscript(...commands: string[]): string {
  const now = Date.now()
  return commands
    .flatMap((cmd, index) => {
      const ts = now - (commands.length - index) * 1000
      return [
        JSON.stringify({
          timestamp: new Date(ts - 1).toISOString(),
          type: "user",
          message: { content: `prompt-${index}` },
        }),
        JSON.stringify({
          timestamp: new Date(ts).toISOString(),
          type: "assistant",
          message: {
            content: [{ type: "tool_use", name: "Bash", input: { command: cmd } }],
          },
        }),
      ]
    })
    .join("\n")
}

function makeOldTranscript(...commands: string[]): string {
  const old = Date.now() - 21 * 60 * 1000
  return commands
    .map((cmd, index) =>
      JSON.stringify({
        timestamp: new Date(old + index * 1000).toISOString(),
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name: "Bash", input: { command: cmd } }],
        },
      })
    )
    .join("\n")
}

const UNIT_DEPENDENCIES: PushChecksGateDependencies = {
  spawn: () =>
    Promise.resolve({
      stdout: "",
      stderr: "not a git repository",
      exitCode: 128,
      timedOut: false,
    }),
  detectForkTopology: () => Promise.resolve(null),
  readGlobalSettings: () => Promise.resolve(buildTestSettings()),
  readProjectSettings: () => Promise.resolve(null),
}

function parseHookOutput(output: Record<string, any>): AdvisoryHookResult {
  const hso = output.hookSpecificOutput
  const decision = hso?.permissionDecision ?? output.decision
  return {
    blocked: decision === "deny",
    reason: hso?.permissionDecisionReason ?? output.reason ?? "",
    advisory: decision === "allow" && !!hso?.permissionDecisionReason,
  }
}

async function runHook(opts: {
  command: string
  transcriptContent?: string
  transcriptPath?: string
  cwd?: string
  effectiveSettings?: Record<string, unknown>
  dependencies?: PushChecksGateDependencies
}): Promise<AdvisoryHookResult> {
  let tPath = opts.transcriptPath ?? ""

  if (opts.transcriptContent !== undefined && !opts.transcriptPath) {
    tPath = join(tmpDir, `t-${Math.random().toString(36).slice(2)}.jsonl`)
    await Bun.write(tPath, opts.transcriptContent)
  }

  const payload = {
    tool_name: "Bash",
    tool_input: { command: opts.command },
    transcript_path: tPath,
    session_id: "test",
    cwd: opts.cwd ?? "/tmp",
    _effectiveSettings: buildEffectiveTestSettings(opts.effectiveSettings ?? {}),
  }

  const output = await evaluatePretoolusePushChecksGate(
    payload,
    opts.dependencies ?? UNIT_DEPENDENCIES
  )
  return parseHookOutput(output)
}

// ─── Temp dir lifecycle ──────────────────────────────────────────────────────

let tmpDir: string

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "push-checks-gate-test-"))
})

afterAll(async () => {
  await rm(tmpDir, { recursive: true })
})

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("pretooluse-push-checks-gate", () => {
  describe("passthrough — non-push commands are never blocked", () => {
    test("git status passes through", async () => {
      const result = await runHook({ command: "git status" })
      expect(result.blocked).toBe(false)
    })

    test("git commit passes through", async () => {
      const result = await runHook({ command: "git commit -m 'wip'" })
      expect(result.blocked).toBe(false)
    })

    test("gh pr list passes through", async () => {
      const result = await runHook({
        command: "gh pr list --state open --head main",
      })
      expect(result.blocked).toBe(false)
    })

    test("git push inside a non-push pipe context does not falsely trigger", async () => {
      // echo containing the word — not an actual push
      const result = await runHook({
        command: "echo 'git push would do this'",
      })
      expect(result.blocked).toBe(false)
    })
  })

  describe("passthrough — no transcript path skips enforcement", () => {
    test("empty transcript path allows push", async () => {
      const result = await runHook({
        command: "git push origin main",
        transcriptPath: "",
      })
      expect(result.blocked).toBe(false)
    })
  })

  describe("allow — both checks present in transcript", () => {
    test("--show-current + gh pr list --head → allowed", async () => {
      const transcript = makeTranscript(
        "git branch --show-current",
        "gh pr list --state open --head main"
      )
      const result = await runHook({
        command: "git push origin main",
        transcriptContent: transcript,
      })
      expect(result.blocked).toBe(false)
    })

    test("checks can appear in any order", async () => {
      const transcript = makeTranscript(
        "gh pr list --state open --head main",
        "git branch --show-current"
      )
      const result = await runHook({
        command: "git push origin main",
        transcriptContent: transcript,
      })
      expect(result.blocked).toBe(false)
    })

    test("checks mixed with other commands still satisfy gate", async () => {
      const transcript = makeTranscript(
        "git status",
        "git branch --show-current",
        "bun test",
        "gh pr list --state open --head feature/x"
      )
      const result = await runHook({
        command: "git push origin feature/x",
        transcriptContent: transcript,
      })
      expect(result.blocked).toBe(false)
    })
  })

  describe("advisory — missing branch check", () => {
    test("bare 'git branch' triggers advisory", async () => {
      const transcript = makeTranscript("git branch", "gh pr list --state open --head main")
      const result = await runHook({
        command: "git push origin main",
        transcriptContent: transcript,
      })
      expect(result.blocked).toBe(false)
      expect(result.advisory).toBe(true)
      expect(result.reason).toContain("Branch ")
    })

    test("'git branch -a' triggers advisory", async () => {
      const transcript = makeTranscript("git branch -a", "gh pr list --state open --head main")
      const result = await runHook({
        command: "git push origin main",
        transcriptContent: transcript,
      })
      expect(result.blocked).toBe(false)
      expect(result.advisory).toBe(true)
    })

    test("'git branch -d feature' triggers advisory", async () => {
      const transcript = makeTranscript(
        "git branch -d old-feature",
        "gh pr list --state open --head main"
      )
      const result = await runHook({
        command: "git push origin main",
        transcriptContent: transcript,
      })
      expect(result.blocked).toBe(false)
      expect(result.advisory).toBe(true)
    })

    test("'git branch -vv' triggers advisory", async () => {
      const transcript = makeTranscript("git branch -vv", "gh pr list --state open --head main")
      const result = await runHook({
        command: "git push origin main",
        transcriptContent: transcript,
      })
      expect(result.blocked).toBe(false)
      expect(result.advisory).toBe(true)
    })
  })

  describe("advisory — missing PR check", () => {
    test("gh pr list without --head triggers advisory", async () => {
      const transcript = makeTranscript("git branch --show-current", "gh pr list --state open")
      const result = await runHook({
        command: "git push origin main",
        transcriptContent: transcript,
      })
      expect(result.blocked).toBe(false)
      expect(result.advisory).toBe(true)
      expect(result.reason).toContain("gh pr list")
    })

    test("--show-current present but no PR check → advisory", async () => {
      const transcript = makeTranscript("git branch --show-current")
      const result = await runHook({
        command: "git push origin main",
        transcriptContent: transcript,
      })
      expect(result.blocked).toBe(false)
      expect(result.advisory).toBe(true)
    })
  })

  describe("advisory — both checks missing", () => {
    test("empty transcript emits advisory", async () => {
      const result = await runHook({
        command: "git push origin main",
        transcriptContent: "",
      })
      expect(result.blocked).toBe(false)
      expect(result.advisory).toBe(true)
      expect(result.reason).toContain("Branch ")
      expect(result.reason).toContain("gh pr list")
    })

    test("unrelated commands trigger advisory for both checks", async () => {
      const transcript = makeTranscript("git status", "bun test", "git log --oneline -5")
      const result = await runHook({
        command: "git push origin main",
        transcriptContent: transcript,
      })
      expect(result.blocked).toBe(false)
      expect(result.advisory).toBe(true)
    })
  })

  describe("advisory — stale checks", () => {
    test("branch and PR checks older than twenty minutes trigger advisory", async () => {
      const result = await runHook({
        command: "git push origin main",
        transcriptContent: makeOldTranscript(
          "git branch --show-current",
          "gh pr list --state open --head main"
        ),
      })
      expect(result.blocked).toBe(false)
      expect(result.advisory).toBe(true)
      expect(result.reason).toContain("last 30 turns and last 20 minutes")
      expect(result.reason).toContain("Branch ")
      expect(result.reason).toContain("gh pr list")
    })

    test("checks outside the last thirty turns trigger advisory", async () => {
      const transcript = makeTranscript(
        "git branch --show-current",
        "gh pr list --state open --head main",
        ...Array.from({ length: 31 }, (_, index) => `echo filler-${index}`)
      )
      const result = await runHook({
        command: "git push origin main",
        transcriptContent: transcript,
      })
      expect(result.blocked).toBe(false)
      expect(result.advisory).toBe(true)
      expect(result.reason).toContain("Branch ")
      expect(result.reason).toContain("gh pr list")
    })
  })

  describe("advisory message content", () => {
    test("explicit trunk mode omits PR-flow guidance and affirms direct push", async () => {
      const result = await runHook({
        command: "git push origin main",
        transcriptContent: makeTranscript("git branch --show-current"),
        effectiveSettings: {
          collaborationMode: "team",
          trunkMode: true,
          strictNoDirectMain: false,
        },
      })

      expect(result.blocked).toBe(false)
      expect(result.advisory).toBe(true)
      expect(result.reason).toContain("Project trunk mode is authoritative")
      expect(result.reason).toContain("push directly to the configured default branch")
      expect(result.reason).toContain(
        "Do not create a feature branch or PR because of repository ownership or collaboration heuristics."
      )
      expect(result.reason).not.toContain("gh pr list")
      expect(result.reason).not.toContain("branch/PR/CI verification is incomplete")
      expect(result.reason).not.toContain("avoid pushing large work directly")
    })

    test("advisory names the specific missing checks", async () => {
      const transcript = makeTranscript("git branch --show-current")
      const result = await runHook({
        command: "git push origin main",
        transcriptContent: transcript,
      })
      expect(result.blocked).toBe(false)
      expect(result.advisory).toBe(true)
      expect(result.reason).toContain("advisory")
      expect(result.reason).toContain("gh pr list --state open --head")
      // The advisory lists only the PR check as missing — no "Branch check" line
      expect(result.reason).not.toContain("Branch check (not run yet)")
    })

    test("advisory lists both checks when both are missing", async () => {
      const result = await runHook({
        command: "git push origin main",
        transcriptContent: "",
      })
      expect(result.reason).toContain("Branch ")
      expect(result.reason).toContain("gh pr list --state open --head")
    })
  })

  describe("push command variants", () => {
    test("git push with upstream flag gets advisory", async () => {
      const result = await runHook({
        command: "git push -u origin feature/x",
        transcriptContent: "",
      })
      expect(result.blocked).toBe(false)
      expect(result.advisory).toBe(true)
    })

    test("git push --force-with-lease gets advisory", async () => {
      const result = await runHook({
        command: "git push --force-with-lease origin main",
        transcriptContent: "",
      })
      expect(result.blocked).toBe(false)
      expect(result.advisory).toBe(true)
    })
  })

  describe("backslash-continuation normalisation", () => {
    test("branch check with backslash-newline continuation is recognised", async () => {
      // normalizeCommand strips \<newline>\s* → " " before regex runs
      const transcript = makeTranscript(
        "git branch \\\n  --show-current",
        "gh pr list --state open --head main"
      )
      const result = await runHook({
        command: "git push origin main",
        transcriptContent: transcript,
      })
      expect(result.blocked).toBe(false)
    })

    test("PR check with backslash-newline continuation is recognised", async () => {
      const transcript = makeTranscript(
        "git branch --show-current",
        "gh pr list --state open \\\n  --head main"
      )
      const result = await runHook({
        command: "git push origin main",
        transcriptContent: transcript,
      })
      expect(result.blocked).toBe(false)
    })

    test("multiple continuations in one command are all collapsed", async () => {
      const transcript = makeTranscript(
        "git \\\n  branch \\\n  --show-current",
        "gh pr list \\\n  --state open \\\n  --head main"
      )
      const result = await runHook({
        command: "git push origin main",
        transcriptContent: transcript,
      })
      expect(result.blocked).toBe(false)
    })

    test("--show-current-upstream still triggers advisory after normalisation", async () => {
      // Normalization must not inadvertently satisfy the branch check for the suffixed variant
      const transcript = makeTranscript(
        "git branch \\\n  --show-current-upstream",
        "gh pr list --state open --head main"
      )
      const result = await runHook({
        command: "git push origin main",
        transcriptContent: transcript,
      })
      expect(result.blocked).toBe(false)
      expect(result.advisory).toBe(true)
      expect(result.reason).toContain("Branch ")
    })
  })
})

// ─── CI check advisory (team / relaxed-collab modes) ─────────────────────────

describe("CI check advisory — prHooksActive modes", () => {
  async function runHookWithMode(
    mode: "team" | "relaxed-collab",
    transcriptCommands: string[]
  ): Promise<AdvisoryHookResult> {
    // Use a per-call subdirectory so concurrent tests don't share config.json
    const projectDir = await mkdtemp(join(tmpDir, `mode-${mode}-`))
    const swizDir = join(projectDir, ".swiz")
    await mkdir(swizDir, { recursive: true })
    await Bun.write(join(swizDir, "config.json"), JSON.stringify({ collaborationMode: mode }))
    const transcript = makeTranscript(...transcriptCommands)
    const tPath = join(tmpDir, `t-${Math.random().toString(36).slice(2)}.jsonl`)
    await Bun.write(tPath, transcript)
    const payload = {
      tool_name: "Bash",
      tool_input: { command: "git push origin main", cwd: projectDir },
      transcript_path: tPath,
      session_id: "test",
      _effectiveSettings: buildEffectiveTestSettings({ collaborationMode: mode, ignoreCi: false }),
    }
    const output = await evaluatePretoolusePushChecksGate(payload, UNIT_DEPENDENCIES)
    return parseHookOutput(output)
  }

  test("relaxed-collab without swiz ci-wait triggers CI check advisory", async () => {
    const result = await runHookWithMode("relaxed-collab", [
      "git branch --show-current",
      "gh pr list --state open --head main",
    ])
    expect(result.blocked).toBe(false)
    expect(result.advisory).toBe(true)
    expect(result.reason).toContain("swiz ci-wait")
    expect(result.reason).toContain("relaxed-collab")
  })

  test("team without swiz ci-wait triggers CI check advisory", async () => {
    const result = await runHookWithMode("team", [
      "git branch --show-current",
      "gh pr list --state open --head main",
    ])
    expect(result.blocked).toBe(false)
    expect(result.advisory).toBe(true)
    expect(result.reason).toContain("swiz ci-wait")
    expect(result.reason).toContain("team")
  })

  test("relaxed-collab with all three checks passes", async () => {
    const result = await runHookWithMode("relaxed-collab", [
      "git branch --show-current",
      "gh pr list --state open --head main",
      "swiz ci-wait abc123 --timeout 300",
    ])
    expect(result.blocked).toBe(false)
    expect(result.reason).toContain("All pre-push checks found")
  })

  test("team with all three checks passes", async () => {
    const result = await runHookWithMode("team", [
      "git branch --show-current",
      "gh pr list --state open --head main",
      "swiz ci-wait abc123 --timeout 300",
    ])
    expect(result.blocked).toBe(false)
    expect(result.reason).toContain("All pre-push checks found")
  })

  test("ignore-ci skips CI advisory for team mode", async () => {
    const projectDir = await mkdtemp(join(tmpDir, "team-ignore-ci-"))
    const swizDir = join(projectDir, ".swiz")
    await mkdir(swizDir, { recursive: true })
    await Bun.write(join(swizDir, "config.json"), JSON.stringify({ collaborationMode: "team" }))
    const transcript = makeTranscript(
      "git branch --show-current",
      "gh pr list --state open --head main"
    )
    const tPath = join(tmpDir, `t-${Math.random().toString(36).slice(2)}.jsonl`)
    await Bun.write(tPath, transcript)
    const payload = {
      tool_name: "Bash",
      tool_input: { command: "git push origin main", cwd: projectDir },
      transcript_path: tPath,
      session_id: "test",
      _effectiveSettings: buildEffectiveTestSettings({
        collaborationMode: "team",
        ignoreCi: true,
      }),
    }
    const output = await evaluatePretoolusePushChecksGate(payload, UNIT_DEPENDENCIES)
    const reason = parseHookOutput(output).reason
    expect(reason).toContain("All pre-push checks found")
    expect(reason).not.toContain("swiz ci-wait")
  })
})

// ─── Parametric regression matrix ────────────────────────────────────────────
// Table-driven: every realistic multiline form of `git branch --show-current`.
// All cases include a valid PR check so the branch check is the only variable.

const PR_CHECK = "gh pr list --state open --head main"

interface BranchVariantCase {
  label: string
  command: string
  /** true = gate should ALLOW push (check satisfied) */
  satisfied: boolean
}

const BRANCH_VARIANT_CASES: BranchVariantCase[] = [
  // ── Canonical forms — must be satisfied ──────────────────────────────────
  {
    label: "single-line canonical",
    command: "git branch --show-current",
    satisfied: true,
  },
  {
    label: "single continuation (LF)",
    command: "git branch \\\n  --show-current",
    satisfied: true,
  },
  {
    label: "single continuation (tab indent)",
    command: "git branch \\\n\t--show-current",
    satisfied: true,
  },
  {
    label: "multiple continuations",
    command: "git \\\n  branch \\\n  --show-current",
    satisfied: true,
  },
  {
    label: "extra trailing whitespace after flag",
    command: "git branch --show-current   ",
    satisfied: true,
  },
  {
    label: "flag followed by comment",
    command: "git branch --show-current # current branch",
    satisfied: true,
  },
  {
    label: "bundled in pipeline after &&",
    command: "git log --oneline -3 && git branch --show-current",
    satisfied: true,
  },
  {
    label: "CRLF line endings in continuation",
    command: "git branch \\\r\n  --show-current",
    satisfied: true,
  },

  // ── Rejected variants — must NOT be satisfied ────────────────────────────
  {
    label: "bare git branch (no flag)",
    command: "git branch",
    satisfied: false,
  },
  {
    label: "git branch -a",
    command: "git branch -a",
    satisfied: false,
  },
  {
    label: "git branch -vv",
    command: "git branch -vv",
    satisfied: false,
  },
  {
    label: "git branch -d old-feature",
    command: "git branch -d old-feature",
    satisfied: false,
  },
  {
    label: "--show-current-upstream (suffixed flag)",
    command: "git branch --show-current-upstream",
    satisfied: false,
  },
  {
    label: "--show-current with continuation then -upstream suffix",
    command: "git branch \\\n  --show-current-upstream",
    satisfied: false,
  },
  {
    label: "flag in a comment only (not a real invocation)",
    command: "echo '# git branch --show-current'",
    satisfied: false,
  },
]

describe("parametric: git branch --show-current variant regression matrix", () => {
  for (const { label, command, satisfied } of BRANCH_VARIANT_CASES) {
    test(label, async () => {
      const transcript = makeTranscript(command, PR_CHECK)
      const result = await runHook({
        command: "git push origin main",
        transcriptContent: transcript,
      })
      expect(result.blocked).toBe(false) // never blocks — advisory only
      if (!satisfied) {
        expect(result.advisory).toBe(true)
        expect(result.reason).toContain("Branch ")
      }
    })
  }
})

// ─── Large file check ─────────────────────────────────────────────────────────

async function gitCmd(args: string[], cwd: string): Promise<void> {
  const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ])
  await p.exited
  if (p.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${stderr || stdout}`)
  }
}

/**
 * Set up a working git repo with a local bare remote so @{upstream} resolves.
 * The bare remote lives at bareDir (must be outside workDir to avoid submodule issues).
 */
async function makeGitRepoWithUpstream(workDir: string, bareDir: string): Promise<void> {
  await mkdir(bareDir, { recursive: true })
  await gitCmd(["init", "--bare", bareDir], tmpDir)
  await gitCmd(["init", workDir], tmpDir)
  for (const [k, v] of [
    ["user.email", "test@example.com"],
    ["user.name", "Test"],
    ["commit.gpgsign", "false"],
  ] as [string, string][]) {
    await gitCmd(["config", k, v], workDir)
  }
  await Bun.write(join(workDir, "README.md"), "hello")
  await gitCmd(["add", "."], workDir)
  await gitCmd(["commit", "-m", "init"], workDir)
  await gitCmd(["remote", "add", "origin", bareDir], workDir)
  await gitCmd(["push", "origin", "HEAD:main"], workDir)
  // Get the current local branch name and set its upstream to origin/main
  const branchProc = Bun.spawn(["git", "branch", "--show-current"], {
    cwd: workDir,
    stdout: "pipe",
    stderr: "pipe",
  })
  const branchName = (await new Response(branchProc.stdout).text()).trim()
  await branchProc.exited
  await gitCmd(["branch", "--set-upstream-to=origin/main", branchName || "main"], workDir)
}

async function runHookInRepo(opts: {
  repoDir: string
  command: string
  transcriptContent?: string
}): Promise<AdvisoryHookResult> {
  const tPath = join(tmpDir, `t-${Math.random().toString(36).slice(2)}.jsonl`)
  await Bun.write(tPath, opts.transcriptContent ?? "")
  const payload = {
    tool_name: "Bash",
    tool_input: { command: opts.command, cwd: opts.repoDir },
    transcript_path: tPath,
    session_id: "test",
    _effectiveSettings: buildEffectiveTestSettings({ ignoreCi: false }),
  }
  const out = (await runHookInProcess("hooks/pretooluse-push-checks-gate.ts", payload)).stdout
  if (!out.trim()) return { blocked: false, reason: "", advisory: false }
  const parsed = JSON.parse(out.trim())
  const hso = parsed?.hookSpecificOutput
  const decision = hso?.permissionDecision ?? parsed?.decision
  return {
    blocked: decision === "deny",
    reason: hso?.permissionDecisionReason ?? parsed?.reason ?? "",
    advisory: decision === "allow" && !!hso?.permissionDecisionReason,
  }
}

describe("large file check", () => {
  async function makeRepo(): Promise<string> {
    const repoDir = await mkdtemp(join(tmpDir, "lf-work-"))
    const bareDir = await mkdtemp(join(tmpDir, "lf-bare-"))
    await makeGitRepoWithUpstream(repoDir, bareDir)
    return repoDir
  }

  test("small file does not block or advise", async () => {
    const repoDir = await makeRepo()
    await Bun.write(join(repoDir, "small.txt"), "x".repeat(100))
    await gitCmd(["add", "."], repoDir)
    await gitCmd(["commit", "-m", "add small"], repoDir)

    const result = await runHookInRepo({
      repoDir,
      command: "git push origin main",
      transcriptContent: makeTranscript(
        "git branch --show-current",
        "gh pr list --state open --head main"
      ),
    })
    expect(result.blocked, `hook blocked unexpectedly: ${result.reason}`).toBe(false)
    expect(result.reason).not.toContain("Large file")
  })

  test("file exceeding warn threshold (>500KB) emits advisory", async () => {
    const repoDir = await makeRepo()
    // 600KB — above warn threshold (500KB), below block threshold (5120KB)
    await Bun.write(join(repoDir, "warn-size.bin"), Buffer.alloc(600 * 1024, 0x61))
    await gitCmd(["add", "."], repoDir)
    await gitCmd(["commit", "-m", "add warn-size"], repoDir)

    const result = await runHookInRepo({
      repoDir,
      command: "git push origin main",
      transcriptContent: makeTranscript(
        "git branch --show-current",
        "gh pr list --state open --head main"
      ),
    })
    expect(result.blocked, `hook blocked unexpectedly: ${result.reason}`).toBe(false)
    expect(result.advisory).toBe(true)
    expect(result.reason).toContain("Large file advisory")
    expect(result.reason).toContain("warn-size.bin")
  })

  test("file exceeding block threshold (>5MB) blocks push", async () => {
    const repoDir = await makeRepo()
    // 6MB — above block threshold (5120KB)
    await Bun.write(join(repoDir, "block-size.bin"), Buffer.alloc(6 * 1024 * 1024, 0x62))
    await gitCmd(["add", "."], repoDir)
    await gitCmd(["commit", "-m", "add block-size"], repoDir)

    const result = await runHookInRepo({
      repoDir,
      command: "git push origin main",
    })
    expect(result.blocked).toBe(true)
    expect(result.reason).toContain("block threshold")
    expect(result.reason).toContain("block-size.bin")
    expect(result.reason).toContain(".gitignore")
    expect(result.reason).toContain("soft HEAD~1")
  })
})

// ─── Fork detection check ────────────────────────────────────────────────────

describe("fork detection check", () => {
  async function makeRepo(): Promise<string> {
    const repoDir = await mkdtemp(join(tmpDir, "fork-work-"))
    const bareDir = await mkdtemp(join(tmpDir, "fork-bare-"))
    await makeGitRepoWithUpstream(repoDir, bareDir)
    return repoDir
  }

  test("non-GitHub remote skips fork check gracefully", async () => {
    const repoDir = await makeRepo()
    await Bun.write(join(repoDir, "f.txt"), "content")
    await gitCmd(["add", "."], repoDir)
    await gitCmd(["commit", "-m", "feat: normal commit"], repoDir)

    // Local bare remote is not a GitHub URL — getRepoSlug returns null,
    // fork check skips, and push proceeds to advisory checks.
    const result = await runHookInRepo({
      repoDir,
      command: "git push origin main",
      transcriptContent: makeTranscript(
        "git branch --show-current",
        "gh pr list --state open --head main"
      ),
    })
    expect(result.blocked, `hook blocked unexpectedly: ${result.reason}`).toBe(false)
    // Should not mention "fork" in the reason
    expect(result.reason).not.toContain("fork")
  })
})

// ─── WIP / fixup / squash commit subject check ──────────────────────────────

describe("wip/fixup/squash commit subject check", () => {
  async function makeRepo(): Promise<string> {
    const repoDir = await mkdtemp(join(tmpDir, "wip-work-"))
    const bareDir = await mkdtemp(join(tmpDir, "wip-bare-"))
    await makeGitRepoWithUpstream(repoDir, bareDir)
    return repoDir
  }

  test("wip: commit blocks push", async () => {
    const repoDir = await makeRepo()
    await Bun.write(join(repoDir, "a.txt"), "wip content")
    await gitCmd(["add", "."], repoDir)
    await gitCmd(["commit", "-m", "wip: half-done refactor"], repoDir)

    const result = await runHookInRepo({
      repoDir,
      command: "git push origin main",
      transcriptContent: makeTranscript(
        "git branch --show-current",
        "gh pr list --state open --head main"
      ),
    })
    expect(result.blocked).toBe(true)
    expect(result.reason).toContain("wip: half-done refactor")
    expect(result.reason).toContain("rebase")
  })

  test("fixup! commit blocks push", async () => {
    const repoDir = await makeRepo()
    await Bun.write(join(repoDir, "b.txt"), "fixup content")
    await gitCmd(["add", "."], repoDir)
    await gitCmd(["commit", "-m", "fixup! fix the thing"], repoDir)

    const result = await runHookInRepo({
      repoDir,
      command: "git push origin main",
      transcriptContent: makeTranscript(
        "git branch --show-current",
        "gh pr list --state open --head main"
      ),
    })
    expect(result.blocked).toBe(true)
    expect(result.reason).toContain("fixup! fix the thing")
  })

  test("squash! commit blocks push", async () => {
    const repoDir = await makeRepo()
    await Bun.write(join(repoDir, "c.txt"), "squash content")
    await gitCmd(["add", "."], repoDir)
    await gitCmd(["commit", "-m", "squash! merge these"], repoDir)

    const result = await runHookInRepo({
      repoDir,
      command: "git push origin main",
      transcriptContent: makeTranscript(
        "git branch --show-current",
        "gh pr list --state open --head main"
      ),
    })
    expect(result.blocked).toBe(true)
    expect(result.reason).toContain("squash! merge these")
  })

  test("normal commit subjects do not block push", async () => {
    const repoDir = await makeRepo()
    await Bun.write(join(repoDir, "d.txt"), "normal content")
    await gitCmd(["add", "."], repoDir)
    await gitCmd(["commit", "-m", "feat(api): add new endpoint"], repoDir)

    const result = await runHookInRepo({
      repoDir,
      command: "git push origin main",
      transcriptContent: makeTranscript(
        "git branch --show-current",
        "gh pr list --state open --head main"
      ),
    })
    expect(result.blocked, `hook blocked unexpectedly: ${result.reason}`).toBe(false)
  })

  test("WIP in uppercase also blocks", async () => {
    const repoDir = await makeRepo()
    await Bun.write(join(repoDir, "e.txt"), "upper wip")
    await gitCmd(["add", "."], repoDir)
    await gitCmd(["commit", "-m", "WIP: uppercase variant"], repoDir)

    const result = await runHookInRepo({
      repoDir,
      command: "git push origin main",
      transcriptContent: makeTranscript(
        "git branch --show-current",
        "gh pr list --state open --head main"
      ),
    })
    expect(result.blocked).toBe(true)
    expect(result.reason).toContain("WIP: uppercase variant")
  })
})

// ─── Behind-remote / force-push bypass ───────────────────────────────────────

describe("behind-remote force-push bypass", () => {
  function dependenciesWithRemoteAhead(): PushChecksGateDependencies {
    return {
      ...UNIT_DEPENDENCIES,
      spawn: (command) =>
        Promise.resolve({
          stdout:
            command[0] === "git" && command[1] === "rev-list" && command[2] === "--count"
              ? "1\n"
              : "",
          stderr: "",
          exitCode: 0,
          timedOut: false,
        }),
    }
  }

  test("plain push is blocked when remote is ahead", async () => {
    const result = await runHook({
      command: "git push origin main",
      transcriptContent: makeTranscript(
        "git branch --show-current",
        "gh pr list --state open --head main"
      ),
      dependencies: dependenciesWithRemoteAhead(),
    })
    expect(result.blocked).toBe(true)
    expect(result.reason).toContain("Remote is ahead")
    expect(result.reason).toContain("git pull --rebase")
  })

  test("--force-with-lease bypasses the behind-remote block", async () => {
    const result = await runHook({
      command: "git push origin main --force-with-lease",
      transcriptContent: makeTranscript(
        "git branch --show-current",
        "gh pr list --state open --head main"
      ),
      dependencies: dependenciesWithRemoteAhead(),
    })
    expect(result.blocked).toBe(false)
  })

  test("--force bypasses the behind-remote block", async () => {
    const result = await runHook({
      command: "git push origin main --force",
      transcriptContent: makeTranscript(
        "git branch --show-current",
        "gh pr list --state open --head main"
      ),
      dependencies: dependenciesWithRemoteAhead(),
    })
    expect(result.blocked).toBe(false)
  })

  test("--force-with-lease still emits advisory when prior checks are missing", async () => {
    const result = await runHook({
      command: "git push origin main --force-with-lease",
      transcriptContent: "",
      dependencies: dependenciesWithRemoteAhead(),
    })
    expect(result.blocked).toBe(false)
    expect(result.advisory).toBe(true)
    expect(result.reason).toContain("Branch ")
  })
})
