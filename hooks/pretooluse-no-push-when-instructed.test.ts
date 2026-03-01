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

  describe("no approval — assistant-generated approval phrases are ignored", () => {
    // Regression suite: every approval pattern must be ignored when it appears
    // in assistant-role text. The agent must not self-approve a push.
    const BLOCK = "DO NOT push to remote without approval"

    test("assistant 'go ahead and push' does NOT lift block", async () => {
      // Risky: agent reasoning often paraphrases user intent with this phrase
      const transcript = makeTranscript(
        userText(BLOCK),
        assistantText("I'll go ahead and push once CI passes")
      )
      expect(
        (await runHook({ command: "git push origin main", transcriptContent: transcript })).blocked
      ).toBe(true)
    })

    test("assistant 'push now' does NOT lift block", async () => {
      // Risky: agent narrating its own actions ("let me push now")
      const transcript = makeTranscript(
        userText(BLOCK),
        assistantText("The tests pass so I need to push now")
      )
      expect(
        (await runHook({ command: "git push origin main", transcriptContent: transcript })).blocked
      ).toBe(true)
    })

    test("assistant 'please push' does NOT lift block", async () => {
      // Risky: agent instructing itself or summarising user intent
      const transcript = makeTranscript(
        userText(BLOCK),
        assistantText("please push the changes to origin")
      )
      expect(
        (await runHook({ command: "git push origin main", transcriptContent: transcript })).blocked
      ).toBe(true)
    })

    test("assistant '/push' at start of a line does NOT lift block", async () => {
      // Risky: agent formatting a skill invocation suggestion on its own line
      const transcript = makeTranscript(
        userText(BLOCK),
        assistantText("Use the skill:\n/push --dry-run")
      )
      expect(
        (await runHook({ command: "git push origin main", transcriptContent: transcript })).blocked
      ).toBe(true)
    })

    test("assistant quoting block reason with 'go ahead and push' does NOT lift block", async () => {
      // Risky: agent explains the hook message, which contains the phrase
      const transcript = makeTranscript(
        userText(BLOCK),
        assistantText(
          "The hook says: 'To push, you must receive explicit approval (e.g. \"go ahead and push\").'"
        )
      )
      expect(
        (await runHook({ command: "git push origin main", transcriptContent: transcript })).blocked
      ).toBe(true)
    })
  })

  describe("approval after block — push is allowed", () => {
    test("/push skill header after block does NOT lift restriction (skill content ≠ user authorisation)", async () => {
      // Regression: "Get committed changes pushed to remote" is the /push skill header.
      // It loads automatically when the agent invokes the skill — it is NOT the user
      // explicitly authorising a push, so it must never lift a block.
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
      expect(result.blocked).toBe(true)
    })

    test("stop hook action plan 'Push N commit(s)' does NOT lift restriction", async () => {
      // Stop-hook action plans are system-generated, not explicit human authorisation.
      // "Push N commit(s) to origin/main" must never be accepted as approval.
      const transcript = makeTranscript(
        userText("DO NOT push to remote without approval"),
        userText("Push 1 commit(s) to 'origin/main' with /push")
      )
      const result = await runHook({
        command: "git push origin main",
        transcriptContent: transcript,
      })
      expect(result.blocked).toBe(true)
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

    test("approval from assistant does NOT lift restriction", async () => {
      // Approval is restricted to user-role only — agent reasoning must never
      // self-approve a push it was instructed not to do.
      const transcript = makeTranscript(
        userText("DO NOT push to remote without approval"),
        assistantText("go ahead and push")
      )
      const result = await runHook({
        command: "git push origin main",
        transcriptContent: transcript,
      })
      expect(result.blocked).toBe(true)
    })
  })

  describe("ordering — approval must come AFTER the block", () => {
    test("approval before block does not lift restriction", async () => {
      // Approval appears first, then the blocking instruction — still blocked
      const transcript = makeTranscript(
        userText("go ahead and push"),
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
        userText("go ahead and push"),
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
        userText("push now"),
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

  describe("ambiguous consent — phrases that resemble approval but do not match", () => {
    const BLOCK = "DO NOT push to remote without approval"

    test("'I'll push it to staging later' does not lift block", async () => {
      const transcript = makeTranscript(userText(BLOCK), userText("I'll push it to staging later"))
      expect(
        (await runHook({ command: "git push origin main", transcriptContent: transcript })).blocked
      ).toBe(true)
    })

    test("'you should push when CI is green' does not lift block", async () => {
      const transcript = makeTranscript(
        userText(BLOCK),
        userText("you should push when CI is green")
      )
      expect(
        (await runHook({ command: "git push origin main", transcriptContent: transcript })).blocked
      ).toBe(true)
    })

    test("'push changes to staging' does not lift block", async () => {
      const transcript = makeTranscript(userText(BLOCK), userText("push changes to staging"))
      expect(
        (await runHook({ command: "git push origin main", transcriptContent: transcript })).blocked
      ).toBe(true)
    })

    test("'a force push could lose history' does not lift block", async () => {
      const transcript = makeTranscript(
        userText(BLOCK),
        userText("a force push could lose history")
      )
      expect(
        (await runHook({ command: "git push origin main", transcriptContent: transcript })).blocked
      ).toBe(true)
    })

    test("'Push 0 commits remaining' does not lift block", async () => {
      // "Push N commit" was previously an approval signal for stop-hook action plans.
      // It is no longer accepted — stop-hook messages are machine-generated, not
      // explicit human authorisation.
      const transcript = makeTranscript(
        userText(BLOCK),
        userText("Push 0 commits remaining in queue")
      )
      expect(
        (await runHook({ command: "git push origin main", transcriptContent: transcript })).blocked
      ).toBe(true)
    })

    test("bare 'push' on its own does not lift block", async () => {
      const transcript = makeTranscript(userText(BLOCK), userText("push"))
      expect(
        (await runHook({ command: "git push origin main", transcriptContent: transcript })).blocked
      ).toBe(true)
    })
  })

  describe("approval pattern precision — path-like strings must not grant approval", () => {
    const BLOCK = "DO NOT push to remote without approval"

    test("'/push-notifications.ts' on its own line does NOT lift block", async () => {
      // Fixed: ^\/push\b was matching /push-anything; now requires whitespace/EOL
      const transcript = makeTranscript(userText(BLOCK), userText("/push-notifications.ts"))
      expect(
        (await runHook({ command: "git push origin main", transcriptContent: transcript })).blocked
      ).toBe(true)
    })

    test("'/push-to-deploy.sh' mentioned in a sentence does NOT lift block", async () => {
      const transcript = makeTranscript(
        userText(BLOCK),
        userText("run /push-to-deploy.sh to release")
      )
      expect(
        (await runHook({ command: "git push origin main", transcriptContent: transcript })).blocked
      ).toBe(true)
    })

    test("'/push ' with trailing space DOES lift block (legitimate invocation)", async () => {
      const transcript = makeTranscript(userText(BLOCK), userText("/push some args"))
      expect(
        (await runHook({ command: "git push origin main", transcriptContent: transcript })).blocked
      ).toBe(false)
    })

    test("'/push' at end of line (no trailing chars) DOES lift block", async () => {
      const transcript = makeTranscript(userText(BLOCK), userText("invoke /push"))
      // "/push" is NOT at the start of the line here, so ^ won't match
      // but the whole text "invoke /push" — /push is not at line start
      expect(
        (await runHook({ command: "git push origin main", transcriptContent: transcript })).blocked
      ).toBe(true)
    })

    test("'/push' alone on its own line DOES lift block", async () => {
      const transcript = makeTranscript(userText(BLOCK), userText("/push"))
      expect(
        (await runHook({ command: "git push origin main", transcriptContent: transcript })).blocked
      ).toBe(false)
    })
  })

  describe("blocking phrase precision — word boundaries and phrase variants", () => {
    test("'never push to main' does NOT trigger a block (not in pattern)", async () => {
      // NO_PUSH_RE requires 'do not' or "don't" — "never" is not covered
      const transcript = makeTranscript(userText("never push to main directly"))
      expect(
        (await runHook({ command: "git push origin main", transcriptContent: transcript })).blocked
      ).toBe(false)
    })

    test("'must not push' does NOT trigger a block (not in pattern)", async () => {
      const transcript = makeTranscript(userText("you must not push this branch"))
      expect(
        (await runHook({ command: "git push origin main", transcriptContent: transcript })).blocked
      ).toBe(false)
    })

    test("'do NOT push' (mixed caps) blocks correctly", async () => {
      const transcript = makeTranscript(userText("do NOT push this to remote"))
      expect(
        (await runHook({ command: "git push origin main", transcriptContent: transcript })).blocked
      ).toBe(true)
    })

    test("'don't push the button' blocks (phrase matches even with unrelated object)", async () => {
      // The pattern is about the phrase structure, not the object of push
      const transcript = makeTranscript(userText("don't push the button on prod"))
      expect(
        (await runHook({ command: "git push origin main", transcriptContent: transcript })).blocked
      ).toBe(true)
    })

    test("'do not pushover' does NOT block — word boundary prevents partial match", async () => {
      // \bpush\b ensures 'pushover' is not matched
      const transcript = makeTranscript(userText("do not pushover the team"))
      expect(
        (await runHook({ command: "git push origin main", transcriptContent: transcript })).blocked
      ).toBe(false)
    })

    test("blocking phrase buried in a long multiline user message is found", async () => {
      const longMessage = [
        "Here are the tasks for today:",
        "1. Run lint checks",
        "2. Fix any TypeScript errors",
        "3. DO NOT push to remote without approval",
        "4. Update the README",
        "5. Close resolved issues",
      ].join("\n")
      const transcript = makeTranscript(userText(longMessage))
      const result = await runHook({
        command: "git push origin main",
        transcriptContent: transcript,
      })
      expect(result.blocked).toBe(true)
      expect(result.reason).toContain("DO NOT push to remote without approval")
    })
  })

  describe("transcript resilience — malformed and mixed-type entries are skipped", () => {
    test("non-JSON lines in transcript are skipped gracefully", async () => {
      const content = [
        "not valid json at all",
        JSON.stringify({
          type: "user",
          message: { content: [{ type: "text", text: "DO NOT push to remote" }] },
        }),
        "another bad line }{",
      ].join("\n")
      const result = await runHook({ command: "git push origin main", transcriptContent: content })
      expect(result.blocked).toBe(true)
    })

    test("entry with missing content array is skipped without error", async () => {
      const content = [
        JSON.stringify({ type: "user", message: {} }),
        JSON.stringify({
          type: "user",
          message: { content: [{ type: "text", text: "DO NOT push to remote" }] },
        }),
      ].join("\n")
      const result = await runHook({ command: "git push origin main", transcriptContent: content })
      expect(result.blocked).toBe(true)
    })

    test("tool_result type blocks in a user message are skipped", async () => {
      // User message with a tool_result block (not text) containing the phrase
      const content = JSON.stringify({
        type: "user",
        message: {
          content: [
            { type: "tool_result", content: "DO NOT push to remote" },
            { type: "text", text: "Normal instruction without the phrase" },
          ],
        },
      })
      // Only the text block is checked — tool_result is not scanned
      const result = await runHook({ command: "git push origin main", transcriptContent: content })
      expect(result.blocked).toBe(false)
    })

    test("system-role entries are ignored entirely", async () => {
      const content = JSON.stringify({
        type: "system",
        message: { content: [{ type: "text", text: "DO NOT push to remote" }] },
      })
      const result = await runHook({ command: "git push origin main", transcriptContent: content })
      expect(result.blocked).toBe(false)
    })
  })

  describe("complex ordering — long interleaved block/approve sequences", () => {
    test("5 alternating block/approve entries — last state (approve) wins", async () => {
      const transcript = makeTranscript(
        userText("DO NOT push to remote"),
        userText("push now"),
        userText("DO NOT push — wait for review"),
        userText("go ahead and push"),
        userText("DO NOT push yet — CI still running"),
        userText("CI finished. go ahead and push")
      )
      const result = await runHook({
        command: "git push origin main",
        transcriptContent: transcript,
      })
      expect(result.blocked).toBe(false)
    })

    test("5 alternating entries — last state (block) wins", async () => {
      const transcript = makeTranscript(
        userText("DO NOT push to remote"),
        userText("push now"),
        userText("DO NOT push — wait for review"),
        userText("go ahead and push"),
        userText("DO NOT push yet — CI still running")
      )
      const result = await runHook({
        command: "git push origin main",
        transcriptContent: transcript,
      })
      expect(result.blocked).toBe(true)
    })

    test("approval then 3 rapid block entries — still blocked", async () => {
      const transcript = makeTranscript(
        userText("go ahead and push"),
        userText("DO NOT push to remote"),
        userText("DO NOT push — CI is red"),
        userText("DO NOT push — conflicts exist")
      )
      const result = await runHook({
        command: "git push origin main",
        transcriptContent: transcript,
      })
      expect(result.blocked).toBe(true)
    })

    test("many unrelated entries between block and approval are ignored", async () => {
      const transcript = makeTranscript(
        userText("DO NOT push to remote without approval"),
        userText("Run the tests first"),
        assistantText("Running tests now"),
        userText("Fix the failing test"),
        assistantText("Fixed. Tests pass."),
        userText("Update the README"),
        assistantText("README updated."),
        userText("go ahead and push")
      )
      const result = await runHook({
        command: "git push origin main",
        transcriptContent: transcript,
      })
      expect(result.blocked).toBe(false)
    })
  })
})
