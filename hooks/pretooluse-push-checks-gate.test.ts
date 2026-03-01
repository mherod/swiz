import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
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
  proc.stdin.write(payload)
  proc.stdin.end()
  const out = await new Response(proc.stdout).text()
  await proc.exited

  if (!out.trim()) return { blocked: false, reason: "" }
  const parsed = JSON.parse(out.trim())
  const hso = parsed?.hookSpecificOutput
  const decision = hso?.permissionDecision ?? parsed?.decision
  return {
    blocked: decision === "deny",
    reason: hso?.permissionDecisionReason ?? parsed?.reason ?? "",
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

  describe("block — missing branch check", () => {
    test("bare 'git branch' does NOT satisfy the gate", async () => {
      const transcript = makeTranscript("git branch", "gh pr list --state open --head main")
      const result = await runHook({
        command: "git push origin main",
        transcriptContent: transcript,
      })
      expect(result.blocked).toBe(true)
      expect(result.reason).toContain("git branch --show-current")
    })

    test("'git branch -a' does NOT satisfy the gate", async () => {
      const transcript = makeTranscript("git branch -a", "gh pr list --state open --head main")
      const result = await runHook({
        command: "git push origin main",
        transcriptContent: transcript,
      })
      expect(result.blocked).toBe(true)
    })

    test("'git branch -d feature' does NOT satisfy the gate", async () => {
      const transcript = makeTranscript(
        "git branch -d old-feature",
        "gh pr list --state open --head main"
      )
      const result = await runHook({
        command: "git push origin main",
        transcriptContent: transcript,
      })
      expect(result.blocked).toBe(true)
    })

    test("'git branch -vv' does NOT satisfy the gate", async () => {
      const transcript = makeTranscript("git branch -vv", "gh pr list --state open --head main")
      const result = await runHook({
        command: "git push origin main",
        transcriptContent: transcript,
      })
      expect(result.blocked).toBe(true)
    })
  })

  describe("block — missing PR check", () => {
    test("gh pr list without --head does NOT satisfy the gate", async () => {
      const transcript = makeTranscript("git branch --show-current", "gh pr list --state open")
      const result = await runHook({
        command: "git push origin main",
        transcriptContent: transcript,
      })
      expect(result.blocked).toBe(true)
      expect(result.reason).toContain("gh pr list")
    })

    test("--show-current present but no PR check → blocked", async () => {
      const transcript = makeTranscript("git branch --show-current")
      const result = await runHook({
        command: "git push origin main",
        transcriptContent: transcript,
      })
      expect(result.blocked).toBe(true)
    })
  })

  describe("block — both checks missing", () => {
    test("empty transcript blocks push", async () => {
      const result = await runHook({
        command: "git push origin main",
        transcriptContent: "",
      })
      expect(result.blocked).toBe(true)
      expect(result.reason).toContain("git branch --show-current")
      expect(result.reason).toContain("gh pr list")
    })

    test("unrelated commands do not satisfy either check", async () => {
      const transcript = makeTranscript("git status", "bun test", "git log --oneline -5")
      const result = await runHook({
        command: "git push origin main",
        transcriptContent: transcript,
      })
      expect(result.blocked).toBe(true)
    })
  })

  describe("block message content", () => {
    test("block reason names the specific missing checks", async () => {
      const transcript = makeTranscript("git branch --show-current")
      const result = await runHook({
        command: "git push origin main",
        transcriptContent: transcript,
      })
      expect(result.blocked).toBe(true)
      expect(result.reason).toContain("BLOCKED")
      expect(result.reason).toContain("gh pr list --state open --head")
      // The block lists only the PR check as missing — no "Branch check" line
      expect(result.reason).not.toContain("Branch check (not run yet)")
    })

    test("block reason lists both checks when both are missing", async () => {
      const result = await runHook({
        command: "git push origin main",
        transcriptContent: "",
      })
      expect(result.reason).toContain("git branch --show-current")
      expect(result.reason).toContain("gh pr list --state open --head")
    })
  })

  describe("push command variants", () => {
    test("git push with upstream flag is also gated", async () => {
      const result = await runHook({
        command: "git push -u origin feature/x",
        transcriptContent: "",
      })
      expect(result.blocked).toBe(true)
    })

    test("git push --force-with-lease is also gated", async () => {
      const result = await runHook({
        command: "git push --force-with-lease origin main",
        transcriptContent: "",
      })
      expect(result.blocked).toBe(true)
    })
  })
})
