import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Build a transcript JSONL string containing Bash tool_use entries. */
function makeTranscript(...commands: string[]): string {
  return commands
    .map((cmd) =>
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name: "Bash", input: { command: cmd } }],
        },
      })
    )
    .join("\n")
}

interface HookResult {
  blocked: boolean
  reason: string
  advisory: boolean
}

async function runHook(opts: {
  command: string
  transcriptContent?: string
  transcriptPath?: string
}): Promise<HookResult> {
  let tPath = opts.transcriptPath ?? ""

  if (opts.transcriptContent !== undefined && !opts.transcriptPath) {
    tPath = join(tmpDir, `t-${Math.random().toString(36).slice(2)}.jsonl`)
    await Bun.write(tPath, opts.transcriptContent)
  }

  const payload = JSON.stringify({
    tool_name: "Bash",
    tool_input: { command: opts.command },
    transcript_path: tPath,
    session_id: "test",
    cwd: "/tmp",
  })

  const proc = Bun.spawn(["bun", "hooks/pretooluse-push-checks-gate.ts"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  void proc.stdin.write(payload)
  void proc.stdin.end()
  const out = await new Response(proc.stdout).text()
  await proc.exited

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
      expect(result.reason).toContain("git branch --show-current")
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
      expect(result.reason).toContain("git branch --show-current")
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

  describe("advisory message content", () => {
    test("advisory names the specific missing checks", async () => {
      const transcript = makeTranscript("git branch --show-current")
      const result = await runHook({
        command: "git push origin main",
        transcriptContent: transcript,
      })
      expect(result.blocked).toBe(false)
      expect(result.advisory).toBe(true)
      expect(result.reason).toContain("Advisory")
      expect(result.reason).toContain("gh pr list --state open --head")
      // The advisory lists only the PR check as missing — no "Branch check" line
      expect(result.reason).not.toContain("Branch check (not run yet)")
    })

    test("advisory lists both checks when both are missing", async () => {
      const result = await runHook({
        command: "git push origin main",
        transcriptContent: "",
      })
      expect(result.reason).toContain("git branch --show-current")
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
      expect(result.reason).toContain("git branch --show-current")
    })
  })
})

// ─── CI check advisory (team / relaxed-collab modes) ─────────────────────────

describe("CI check advisory — prHooksActive modes", () => {
  async function runHookWithMode(
    mode: "team" | "relaxed-collab",
    transcriptCommands: string[]
  ): Promise<HookResult> {
    // Use a per-call subdirectory so concurrent tests don't share config.json
    const projectDir = await mkdtemp(join(tmpDir, `mode-${mode}-`))
    const swizDir = join(projectDir, ".swiz")
    await mkdir(swizDir, { recursive: true })
    await Bun.write(join(swizDir, "config.json"), JSON.stringify({ collaborationMode: mode }))
    const transcript = makeTranscript(...transcriptCommands)
    const tPath = join(tmpDir, `t-${Math.random().toString(36).slice(2)}.jsonl`)
    await Bun.write(tPath, transcript)
    const payload = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "git push origin main", cwd: projectDir },
      transcript_path: tPath,
      session_id: "test",
    })
    const proc = Bun.spawn(["bun", "hooks/pretooluse-push-checks-gate.ts"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    void proc.stdin.write(payload)
    void proc.stdin.end()
    const out = await new Response(proc.stdout).text()
    await proc.exited
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
    const home = await mkdtemp(join(tmpDir, "ignore-ci-home-"))
    await mkdir(join(home, ".swiz"), { recursive: true })
    await Bun.write(join(home, ".swiz", "settings.json"), JSON.stringify({ ignoreCi: true }))
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
    const payload = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "git push origin main", cwd: projectDir },
      transcript_path: tPath,
      session_id: "test",
    })
    const proc = Bun.spawn(["bun", "hooks/pretooluse-push-checks-gate.ts"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HOME: home },
    })
    void proc.stdin.write(payload)
    void proc.stdin.end()
    const out = await new Response(proc.stdout).text()
    await proc.exited
    expect(out.trim()).toBeTruthy()
    const parsed = JSON.parse(out.trim())
    const reason = parsed?.hookSpecificOutput?.permissionDecisionReason ?? ""
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
        expect(result.reason).toContain("git branch --show-current")
      }
    })
  }
})
