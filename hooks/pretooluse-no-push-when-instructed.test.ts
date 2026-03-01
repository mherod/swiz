import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Build a transcript JSONL string from explicit entry descriptors. */
function makeTranscript(...entries: Array<{ role: "user" | "assistant"; text: string }>): string {
  return entries
    .map(({ role, text }) =>
      JSON.stringify({
        type: role,
        message: {
          content: [{ type: "text", text }],
        },
      })
    )
    .join("\n")
}

function userText(text: string) {
  return { role: "user" as const, text }
}

function assistantText(text: string) {
  return { role: "assistant" as const, text }
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

  const proc = Bun.spawn(["bun", "hooks/pretooluse-no-push-when-instructed.ts"], {
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
  tmpDir = await mkdtemp(join(tmpdir(), "no-push-instructed-test-"))
})

afterAll(async () => {
  await rm(tmpDir, { recursive: true })
})

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("pretooluse-no-push-when-instructed", () => {
  describe("passthrough — non-push commands are never blocked", () => {
    test("git status passes through", async () => {
      const transcript = makeTranscript(userText("DO NOT push to remote without approval"))
      const result = await runHook({ command: "git status", transcriptContent: transcript })
      expect(result.blocked).toBe(false)
    })

    test("git commit passes through even with do-not-push in transcript", async () => {
      const transcript = makeTranscript(userText("Do not push to remote"))
      const result = await runHook({
        command: "git commit -m 'wip'",
        transcriptContent: transcript,
      })
      expect(result.blocked).toBe(false)
    })

    test("git push inside echo string does not trigger", async () => {
      // GIT_PUSH_RE guards on command-level patterns; echo is not a push
      const result = await runHook({
        command: "echo 'git push would do X'",
        transcriptContent: makeTranscript(userText("DO NOT push to remote")),
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

  describe("passthrough — no do-not-push instruction in transcript", () => {
    test("empty transcript allows push", async () => {
      const result = await runHook({
        command: "git push origin main",
        transcriptContent: "",
      })
      expect(result.blocked).toBe(false)
    })

    test("transcript with unrelated content allows push", async () => {
      const transcript = makeTranscript(
        userText("Please run the test suite"),
        assistantText("Running tests now")
      )
      const result = await runHook({
        command: "git push origin main",
        transcriptContent: transcript,
      })
      expect(result.blocked).toBe(false)
    })
  })

  describe("block — user-issued do-not-push instruction", () => {
    test("'DO NOT push to remote' from user blocks push", async () => {
      const transcript = makeTranscript(
        userText("DO NOT push to remote without approval — commit skill")
      )
      const result = await runHook({
        command: "git push origin main",
        transcriptContent: transcript,
      })
      expect(result.blocked).toBe(true)
      expect(result.reason).toContain("BLOCKED")
    })

    test("'Do not push' (mixed case) from user blocks push", async () => {
      const transcript = makeTranscript(userText("Do not push until CI is green"))
      const result = await runHook({
        command: "git push origin main",
        transcriptContent: transcript,
      })
      expect(result.blocked).toBe(true)
    })

    test("'do not push' (lowercase) from user blocks push", async () => {
      const transcript = makeTranscript(userText("do not push to the remote yet"))
      const result = await runHook({
        command: "git push origin main",
        transcriptContent: transcript,
      })
      expect(result.blocked).toBe(true)
    })

    test('"don\'t push" from user blocks push', async () => {
      const transcript = makeTranscript(userText("Don't push this to remote"))
      const result = await runHook({
        command: "git push origin main",
        transcriptContent: transcript,
      })
      expect(result.blocked).toBe(true)
    })

    test("block reason quotes the matching instruction line", async () => {
      const transcript = makeTranscript(
        userText("Stage changes and commit. Do not push. Preserve work first.")
      )
      const result = await runHook({
        command: "git push origin main",
        transcriptContent: transcript,
      })
      expect(result.blocked).toBe(true)
      expect(result.reason).toContain("Do not push.")
    })

    test("git push -u origin is also blocked", async () => {
      const transcript = makeTranscript(userText("DO NOT push to remote"))
      const result = await runHook({
        command: "git push -u origin feature/x",
        transcriptContent: transcript,
      })
      expect(result.blocked).toBe(true)
    })
  })

  describe("no block — assistant text with 'do not push' is ignored", () => {
    test("assistant reasoning about 'do not push' does not block", async () => {
      const transcript = makeTranscript(
        // Simulates this agent's own insight text discussing the pattern
        assistantText(
          "The hook needs ordered scanning. Presence of do not push AND approval both matter — which came last is what counts."
        )
      )
      const result = await runHook({
        command: "git push origin main",
        transcriptContent: transcript,
      })
      expect(result.blocked).toBe(false)
    })

    test("assistant quoting the commit skill instruction does not block", async () => {
      const transcript = makeTranscript(
        assistantText(
          'The /commit skill says "DO NOT push to remote without approval" — this is just my explanation.'
        )
      )
      const result = await runHook({
        command: "git push origin main",
        transcriptContent: transcript,
      })
      expect(result.blocked).toBe(false)
    })

    test("only user-role entries trigger the block, not assistant-role", async () => {
      // user entry has no do-not-push; assistant does — should allow
      const transcript = makeTranscript(
        userText("Please go ahead and make any necessary commits"),
        assistantText("I see the pattern: do not push unless approved")
      )
      const result = await runHook({
        command: "git push origin main",
        transcriptContent: transcript,
      })
      expect(result.blocked).toBe(false)
    })
  })

  describe("approval after block — push is allowed", () => {
    test("/push skill header after block lifts restriction", async () => {
      const transcript = makeTranscript(
        userText("DO NOT push to remote without approval"),
        userText(
          "Get committed changes pushed to remote. Fast and professional push skill content here."
        )
      )
      const result = await runHook({
        command: "git push origin main",
        transcriptContent: transcript,
      })
      expect(result.blocked).toBe(false)
    })

    test("stop hook action plan 'Push N commit(s)' lifts restriction", async () => {
      const transcript = makeTranscript(
        userText("DO NOT push to remote without approval"),
        userText("Push 1 commit(s) to 'origin/main' with /push")
      )
      const result = await runHook({
        command: "git push origin main",
        transcriptContent: transcript,
      })
      expect(result.blocked).toBe(false)
    })

    test("'go ahead and push' from user lifts restriction", async () => {
      const transcript = makeTranscript(
        userText("DO NOT push to remote without approval"),
        userText("go ahead and push")
      )
      const result = await runHook({
        command: "git push origin main",
        transcriptContent: transcript,
      })
      expect(result.blocked).toBe(false)
    })

    test("'/push' on its own line lifts restriction", async () => {
      const transcript = makeTranscript(
        userText("DO NOT push to remote without approval"),
        userText("/push")
      )
      const result = await runHook({
        command: "git push origin main",
        transcriptContent: transcript,
      })
      expect(result.blocked).toBe(false)
    })

    test("'push now' from user lifts restriction", async () => {
      const transcript = makeTranscript(
        userText("DO NOT push to remote without approval"),
        userText("push now")
      )
      const result = await runHook({
        command: "git push origin main",
        transcriptContent: transcript,
      })
      expect(result.blocked).toBe(false)
    })

    test("'please push' from user lifts restriction", async () => {
      const transcript = makeTranscript(
        userText("DO NOT push to remote without approval"),
        userText("please push the changes")
      )
      const result = await runHook({
        command: "git push origin main",
        transcriptContent: transcript,
      })
      expect(result.blocked).toBe(false)
    })

    test("approval from assistant (not just user) lifts restriction", async () => {
      // approval check doesn't restrict to user role — any role counts
      const transcript = makeTranscript(
        userText("DO NOT push to remote without approval"),
        assistantText("Get committed changes pushed to remote.")
      )
      const result = await runHook({
        command: "git push origin main",
        transcriptContent: transcript,
      })
      expect(result.blocked).toBe(false)
    })
  })

  describe("ordering — approval must come AFTER the block", () => {
    test("approval before block does not lift restriction", async () => {
      // Approval appears first, then the blocking instruction — still blocked
      const transcript = makeTranscript(
        userText("Get committed changes pushed to remote. Push skill content."),
        userText("DO NOT push to remote without approval")
      )
      const result = await runHook({
        command: "git push origin main",
        transcriptContent: transcript,
      })
      expect(result.blocked).toBe(true)
    })

    test("second block after approval re-blocks push", async () => {
      // block → approval → block: the last state is blocked
      const transcript = makeTranscript(
        userText("DO NOT push to remote without approval"),
        userText("Get committed changes pushed to remote."),
        userText("DO NOT push to remote — wait for CI to finish")
      )
      const result = await runHook({
        command: "git push origin main",
        transcriptContent: transcript,
      })
      expect(result.blocked).toBe(true)
    })

    test("second approval after second block lifts restriction again", async () => {
      const transcript = makeTranscript(
        userText("DO NOT push to remote without approval"),
        userText("Get committed changes pushed to remote."),
        userText("DO NOT push to remote — wait for CI"),
        userText("CI is green. go ahead and push")
      )
      const result = await runHook({
        command: "git push origin main",
        transcriptContent: transcript,
      })
      expect(result.blocked).toBe(false)
    })
  })
})
