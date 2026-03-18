import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeTranscript } from "./test-utils.ts"

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Build a JSONL entry for a shell tool_use + its tool_result. */
function shellCommandEntry(command: string): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          name: "Bash",
          input: { command },
        },
      ],
    },
  })
}

function toolResultEntry(text: string): string {
  return JSON.stringify({
    type: "tool_result",
    content: [{ type: "text", text }],
  })
}

function assistantTextEntry(text: string): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      content: [{ type: "text", text }],
    },
  })
}

function editToolEntry(file: string, oldStr: string, newStr: string): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          name: "Edit",
          input: { file_path: file, old_string: oldStr, new_string: newStr },
        },
      ],
    },
  })
}

function readToolEntry(file: string): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          name: "Read",
          input: { file_path: file },
        },
      ],
    },
  })
}

function systemBoundaryEntry(): string {
  return JSON.stringify({ type: "system", content: "Session resumed after compaction." })
}

interface HookResult {
  blocked: boolean
  reason: string
}

async function runHook(opts: {
  toolName?: string
  command?: string
  transcriptContent: string
}): Promise<HookResult> {
  const tPath = join(tmpDir, `t-${Math.random().toString(36).slice(2)}.jsonl`)
  await Bun.write(tPath, opts.transcriptContent)

  const toolName = opts.toolName ?? "Bash"
  const toolInput =
    toolName === "Bash"
      ? { command: opts.command ?? "echo hello" }
      : { file_path: "/tmp/test.ts", old_string: "a", new_string: "b" }

  const payload = JSON.stringify({
    tool_name: toolName,
    tool_input: toolInput,
    transcript_path: tPath,
    session_id: "test",
    cwd: tmpDir,
  })

  const proc = Bun.spawn(["bun", "hooks/pretooluse-block-preexisting-dismissals.ts"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  void proc.stdin.write(payload)
  void proc.stdin.end()
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
  tmpDir = await mkdtemp(join(tmpdir(), "preexisting-dismissals-test-"))
  // Init a git repo so isGitRepo check passes
  const proc = Bun.spawn(["git", "init"], { cwd: tmpDir, stdout: "pipe", stderr: "pipe" })
  await proc.exited
})

afterAll(async () => {
  await rm(tmpDir, { recursive: true })
})

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("pretooluse-block-preexisting-dismissals", () => {
  describe("passthrough — no diagnostic output", () => {
    test("empty transcript allows tool calls", async () => {
      const result = await runHook({ transcriptContent: "" })
      expect(result.blocked).toBe(false)
    })

    test("transcript without diagnostic output allows tool calls", async () => {
      const transcript = makeTranscript(
        shellCommandEntry("git status"),
        toolResultEntry("On branch main\nnothing to commit"),
        assistantTextEntry("The working tree is clean. These are pre-existing files.")
      )
      const result = await runHook({ transcriptContent: transcript })
      expect(result.blocked).toBe(false)
    })
  })

  describe("passthrough — no dismissal claim", () => {
    test("diagnostic output without dismissal allows tool calls", async () => {
      const transcript = makeTranscript(
        shellCommandEntry("bun run lint"),
        toolResultEntry("src/foo.ts:10:5 error: Unused variable 'x'\n✖ 1 problem"),
        assistantTextEntry("I see a lint error. Let me fix it.")
      )
      const result = await runHook({ transcriptContent: transcript })
      expect(result.blocked).toBe(false)
    })
  })

  describe("block — dismissal after diagnostic output", () => {
    test("'pre-existing' claim after lint errors blocks", async () => {
      const transcript = makeTranscript(
        shellCommandEntry("bun run lint"),
        toolResultEntry("src/foo.ts:10:5 warning: Unused variable\n✖ 1 problem"),
        assistantTextEntry("This warning is pre-existing and unrelated to our changes.")
      )
      const result = await runHook({ transcriptContent: transcript })
      expect(result.blocked).toBe(true)
      expect(result.reason).toContain("pre-existing")
    })

    test("'existed before' claim after test failures blocks", async () => {
      const transcript = makeTranscript(
        shellCommandEntry("bun test --concurrent"),
        toolResultEntry("FAIL src/utils.test.ts\n  ✗ should validate input"),
        assistantTextEntry("This test failure existed before our refactoring.")
      )
      const result = await runHook({ transcriptContent: transcript })
      expect(result.blocked).toBe(true)
      expect(result.reason).toContain("existed before")
    })

    test("'unrelated to this refactor' claim blocks", async () => {
      const transcript = makeTranscript(
        shellCommandEntry("bun run typecheck"),
        toolResultEntry("src/api.ts(15,3): error TS2322: Type 'string' is not assignable"),
        assistantTextEntry("This type error is unrelated to this refactor.")
      )
      const result = await runHook({ transcriptContent: transcript })
      expect(result.blocked).toBe(true)
    })

    test("'not introduced by' claim blocks", async () => {
      const transcript = makeTranscript(
        shellCommandEntry("bun run lint"),
        toolResultEntry("src/x.ts:5:1 error: Missing return type\n✖ 1 problem"),
        assistantTextEntry("This error was not introduced by our changes.")
      )
      const result = await runHook({ transcriptContent: transcript })
      expect(result.blocked).toBe(true)
    })

    test("'no new errors' claim blocks", async () => {
      const transcript = makeTranscript(
        shellCommandEntry("bun run lint"),
        toolResultEntry("src/x.ts:5:1 warning: Unused import\n✖ 1 problem"),
        assistantTextEntry("There are no new errors from our changes.")
      )
      const result = await runHook({ transcriptContent: transcript })
      expect(result.blocked).toBe(true)
    })

    test("'already present' claim blocks", async () => {
      const transcript = makeTranscript(
        shellCommandEntry("bun run typecheck"),
        toolResultEntry("error TS2345: Argument of type 'number' is not assignable"),
        assistantTextEntry("This type error was already present before our work.")
      )
      const result = await runHook({ transcriptContent: transcript })
      expect(result.blocked).toBe(true)
    })

    test("'outside the scope' claim blocks", async () => {
      const transcript = makeTranscript(
        shellCommandEntry("bun run lint"),
        toolResultEntry("src/old.ts:100:1 warning: complexity\n✖ 1 problem"),
        assistantTextEntry("This warning is outside the scope of our current changes.")
      )
      const result = await runHook({ transcriptContent: transcript })
      expect(result.blocked).toBe(true)
    })

    test("block message includes diagnostic snippet", async () => {
      const transcript = makeTranscript(
        shellCommandEntry("bun run lint"),
        toolResultEntry("src/foo.ts:10:5 warning: Unused variable 'x'\n✖ 1 problem"),
        assistantTextEntry("That warning is pre-existing.")
      )
      const result = await runHook({ transcriptContent: transcript })
      expect(result.blocked).toBe(true)
      expect(result.reason).toContain("warning")
    })

    test("blocks Edit tool calls too, not just Bash", async () => {
      const transcript = makeTranscript(
        shellCommandEntry("bun run lint"),
        toolResultEntry("src/foo.ts:10:5 error: Missing semicolon\n✖ 1 problem"),
        assistantTextEntry("This error is pre-existing in the codebase.")
      )
      const result = await runHook({
        toolName: "Edit",
        transcriptContent: transcript,
      })
      expect(result.blocked).toBe(true)
    })
  })

  describe("gate clears — fix applied after dismissal", () => {
    test("edit tool call after dismissal clears the gate", async () => {
      const transcript = makeTranscript(
        shellCommandEntry("bun run lint"),
        toolResultEntry("src/foo.ts:10:5 warning: Unused variable\n✖ 1 problem"),
        assistantTextEntry("This warning is pre-existing."),
        editToolEntry("src/foo.ts", "const x = 1", "")
      )
      const result = await runHook({ transcriptContent: transcript })
      expect(result.blocked).toBe(false)
    })
  })

  describe("gate clears — scoped verification after dismissal", () => {
    test("lint on specific file after dismissal clears the gate", async () => {
      const transcript = makeTranscript(
        shellCommandEntry("bun run lint"),
        toolResultEntry("src/foo.ts:10:5 warning: Unused variable\n✖ 1 problem"),
        assistantTextEntry("This warning is pre-existing."),
        shellCommandEntry("bun run lint --only src/changed.ts")
      )
      const result = await runHook({ transcriptContent: transcript })
      expect(result.blocked).toBe(false)
    })
  })

  describe("gate clears — baseline evidence after dismissal", () => {
    test("git diff after dismissal clears the gate", async () => {
      const transcript = makeTranscript(
        shellCommandEntry("bun run lint"),
        toolResultEntry("src/foo.ts:10:5 warning: Unused variable\n✖ 1 problem"),
        assistantTextEntry("This warning is pre-existing."),
        shellCommandEntry("git diff main -- src/foo.ts")
      )
      const result = await runHook({ transcriptContent: transcript })
      expect(result.blocked).toBe(false)
    })

    test("git log after dismissal clears the gate", async () => {
      const transcript = makeTranscript(
        shellCommandEntry("bun run lint"),
        toolResultEntry("src/foo.ts:10:5 warning: Unused variable\n✖ 1 problem"),
        assistantTextEntry("This warning is pre-existing."),
        shellCommandEntry("git log --oneline -5 src/foo.ts")
      )
      const result = await runHook({ transcriptContent: transcript })
      expect(result.blocked).toBe(false)
    })
  })

  describe("passthrough — diagnostic command itself is not blocked", () => {
    test("running lint after dismissal is not blocked (it is proof)", async () => {
      const transcript = makeTranscript(
        shellCommandEntry("bun run lint"),
        toolResultEntry("src/foo.ts:10:5 warning: Unused variable\n✖ 1 problem"),
        assistantTextEntry("This warning is pre-existing.")
      )
      const result = await runHook({
        command: "bun run lint",
        transcriptContent: transcript,
      })
      expect(result.blocked).toBe(false)
    })

    test("running test after dismissal is not blocked", async () => {
      const transcript = makeTranscript(
        shellCommandEntry("bun test --concurrent"),
        toolResultEntry("FAIL src/a.test.ts\n  ✗ broken test"),
        assistantTextEntry("This failure is pre-existing.")
      )
      const result = await runHook({
        command: "bun test --concurrent",
        transcriptContent: transcript,
      })
      expect(result.blocked).toBe(false)
    })

    test("running typecheck after dismissal is not blocked", async () => {
      const transcript = makeTranscript(
        shellCommandEntry("bun run typecheck"),
        toolResultEntry("error TS2345: Argument of type 'number'"),
        assistantTextEntry("This error was already existing.")
      )
      const result = await runHook({
        command: "bun run typecheck",
        transcriptContent: transcript,
      })
      expect(result.blocked).toBe(false)
    })
  })

  describe("false positive avoidance", () => {
    test("'pre-existing' in unrelated assistant text without diagnostics is not blocked", async () => {
      const transcript = makeTranscript(
        shellCommandEntry("git status"),
        toolResultEntry("On branch main\nnothing to commit"),
        assistantTextEntry("The pre-existing documentation covers this topic well.")
      )
      const result = await runHook({ transcriptContent: transcript })
      expect(result.blocked).toBe(false)
    })

    test("new diagnostic output after dismissed one resets the cycle", async () => {
      const transcript = makeTranscript(
        shellCommandEntry("bun run lint"),
        toolResultEntry("src/foo.ts:10:5 warning: Unused variable\n✖ 1 problem"),
        assistantTextEntry("This is pre-existing."),
        // New clean diagnostic output resets the cycle
        shellCommandEntry("bun run lint"),
        toolResultEntry("All checks passed! No errors.")
      )
      const result = await runHook({ transcriptContent: transcript })
      // No diagnostic issues in the latest output, so no block
      expect(result.blocked).toBe(false)
    })

    test("dismissal followed by new diagnostic errors re-triggers on new dismissal", async () => {
      const transcript = makeTranscript(
        shellCommandEntry("bun run lint"),
        toolResultEntry("src/a.ts:1:1 warning: unused\n✖ 1 problem"),
        assistantTextEntry("Pre-existing warning."),
        editToolEntry("src/a.ts", "const x", ""),
        // New run with new errors
        shellCommandEntry("bun run lint"),
        toolResultEntry("src/b.ts:5:1 error: Missing return\n✖ 1 problem"),
        assistantTextEntry("This error is not introduced by our changes.")
      )
      const result = await runHook({ transcriptContent: transcript })
      expect(result.blocked).toBe(true)
    })

    test("non-git directory is not blocked", async () => {
      const nonGitDir = await mkdtemp(join(tmpdir(), "nongit-"))
      const tPath = join(nonGitDir, "transcript.jsonl")
      await Bun.write(
        tPath,
        makeTranscript(
          shellCommandEntry("bun run lint"),
          toolResultEntry("error: something failed"),
          assistantTextEntry("This is pre-existing.")
        )
      )

      const payload = JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: "echo hello" },
        transcript_path: tPath,
        session_id: "test",
        cwd: nonGitDir,
      })

      const proc = Bun.spawn(["bun", "hooks/pretooluse-block-preexisting-dismissals.ts"], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      })
      void proc.stdin.write(payload)
      void proc.stdin.end()
      const out = await new Response(proc.stdout).text()
      await proc.exited

      expect(out.trim()).toBe("")
      await rm(nonGitDir, { recursive: true })
    })
  })

  describe("existing issue variant (no 'pre-' prefix)", () => {
    test("'an existing issue' blocks", async () => {
      const transcript = makeTranscript(
        shellCommandEntry("bun run lint"),
        toolResultEntry("src/x.ts:5:1 error: Unused variable\n✖ 1 problem"),
        assistantTextEntry("This is an existing issue in the codebase.")
      )
      const result = await runHook({ transcriptContent: transcript })
      expect(result.blocked).toBe(true)
    })

    test("'existing bug' blocks", async () => {
      const transcript = makeTranscript(
        shellCommandEntry("bun run typecheck"),
        toolResultEntry("src/api.ts(5,3): error TS2322: Type mismatch"),
        assistantTextEntry("That error is an existing bug unrelated to our PR.")
      )
      const result = await runHook({ transcriptContent: transcript })
      expect(result.blocked).toBe(true)
    })
  })

  describe("already broken/failing variant", () => {
    test("'already broken' blocks", async () => {
      const transcript = makeTranscript(
        shellCommandEntry("bun test --concurrent"),
        toolResultEntry("FAIL src/utils.test.ts\n  ✗ should parse input"),
        assistantTextEntry("This test was already broken before I started.")
      )
      const result = await runHook({ transcriptContent: transcript })
      expect(result.blocked).toBe(true)
    })

    test("'already failing' blocks", async () => {
      const transcript = makeTranscript(
        shellCommandEntry("bun run lint"),
        toolResultEntry("src/foo.ts:10:5 error: Missing return type\n✖ 1 problem"),
        assistantTextEntry("This check was already failing in main.")
      )
      const result = await runHook({ transcriptContent: transcript })
      expect(result.blocked).toBe(true)
    })
  })

  describe("first-person authorship denial", () => {
    test("'I didn't cause this' blocks", async () => {
      const transcript = makeTranscript(
        shellCommandEntry("bun run lint"),
        toolResultEntry("src/old.ts:20:1 warning: complexity\n✖ 1 problem"),
        assistantTextEntry("I didn't cause this — it was there before my edits.")
      )
      const result = await runHook({ transcriptContent: transcript })
      expect(result.blocked).toBe(true)
    })

    test("'I didn't introduce this' blocks", async () => {
      const transcript = makeTranscript(
        shellCommandEntry("bun run typecheck"),
        toolResultEntry("error TS2345: Argument of type 'number' is not assignable"),
        assistantTextEntry("I didn't introduce this type error.")
      )
      const result = await runHook({ transcriptContent: transcript })
      expect(result.blocked).toBe(true)
    })
  })

  describe("nothing-to-do-with variant", () => {
    test("'nothing to do with my changes' blocks", async () => {
      const transcript = makeTranscript(
        shellCommandEntry("bun run lint"),
        toolResultEntry("src/legacy.ts:5:1 warning: Unused import\n✖ 1 problem"),
        assistantTextEntry("This warning has nothing to do with my changes.")
      )
      const result = await runHook({ transcriptContent: transcript })
      expect(result.blocked).toBe(true)
    })

    test("'nothing to do with our work' blocks", async () => {
      const transcript = makeTranscript(
        shellCommandEntry("bun run typecheck"),
        toolResultEntry(
          "src/legacy.ts(10,5): error TS7006: Parameter 'x' implicitly has an 'any' type"
        ),
        assistantTextEntry("This error has nothing to do with our work here.")
      )
      const result = await runHook({ transcriptContent: transcript })
      expect(result.blocked).toBe(true)
    })
  })

  describe("predates claim variant", () => {
    test("'predates this change' blocks", async () => {
      const transcript = makeTranscript(
        shellCommandEntry("bun run lint"),
        toolResultEntry("src/x.ts:5:1 warning: complexity\n✖ 1 problem"),
        assistantTextEntry("This warning predates this change.")
      )
      const result = await runHook({ transcriptContent: transcript })
      expect(result.blocked).toBe(true)
    })
  })

  describe("not caused by claim variant", () => {
    test("'not caused by our changes' blocks", async () => {
      const transcript = makeTranscript(
        shellCommandEntry("bun run typecheck"),
        toolResultEntry("error TS2322: Type 'string' is not assignable"),
        assistantTextEntry("This type error is not caused by our changes.")
      )
      const result = await runHook({ transcriptContent: transcript })
      expect(result.blocked).toBe(true)
    })
  })

  describe("non-diagnostic tool results do not clear state", () => {
    test("task completion output between dismissal and blocked tool does not clear", async () => {
      const transcript = makeTranscript(
        shellCommandEntry("bun test --concurrent"),
        toolResultEntry("5571 pass\n127 fail\nRan 5700 tests across 164 files."),
        assistantTextEntry("The 127 remaining failures are likely pre-existing."),
        // Task completion — non-diagnostic tool result must not clear state
        shellCommandEntry('swiz tasks complete 3 --evidence "note:tests pass"'),
        toolResultEntry(
          "✅ #3: in_progress → completed\n  Ensure tests pass\n  Evidence: note:tests pass"
        )
      )
      const result = await runHook({ transcriptContent: transcript })
      expect(result.blocked).toBe(true)
      expect(result.reason).toContain("pre-existing")
    })

    test("file read output between dismissal and blocked tool does not clear", async () => {
      const transcript = makeTranscript(
        shellCommandEntry("bun run lint"),
        toolResultEntry("src/foo.ts:10:5 warning: Unused variable\n✖ 1 problem"),
        assistantTextEntry("This warning is pre-existing."),
        // Read tool use + result — non-diagnostic, should not clear
        readToolEntry("src/foo.ts"),
        toolResultEntry("1→#!/usr/bin/env bun\n2→import { run } from './cli.ts'\n3→\n4→await run()")
      )
      const result = await runHook({ transcriptContent: transcript })
      expect(result.blocked).toBe(true)
    })
  })

  describe("exempt command — verb-only matching", () => {
    test("swiz tasks complete with 'test' in evidence is NOT exempt", async () => {
      const transcript = makeTranscript(
        shellCommandEntry("bun test --concurrent"),
        toolResultEntry("5571 pass\n127 fail\nRan 5700 tests across 164 files."),
        assistantTextEntry("These failures are pre-existing.")
      )
      const result = await runHook({
        command: 'swiz tasks complete 3 --evidence "note:tests pass — 127 fail (pre-existing)"',
        transcriptContent: transcript,
      })
      expect(result.blocked).toBe(true)
    })

    test("git commit with 'test' in message is NOT exempt", async () => {
      const transcript = makeTranscript(
        shellCommandEntry("bun run lint"),
        toolResultEntry("src/foo.ts:10:5 warning: Unused variable\n✖ 1 problem"),
        assistantTextEntry("This warning is pre-existing.")
      )
      const result = await runHook({
        command: 'git commit -m "test: add test for feature"',
        transcriptContent: transcript,
      })
      expect(result.blocked).toBe(true)
    })
  })

  describe("cross-session — dismissal before session boundary", () => {
    test("dismissal in prior session (before system boundary) still blocks", async () => {
      const transcript = makeTranscript(
        // Prior session: diagnostic + dismissal
        shellCommandEntry("bun run lint"),
        toolResultEntry("src/foo.ts:10:5 warning: Unused variable\n✖ 1 problem"),
        assistantTextEntry("This warning is pre-existing."),
        // Session boundary (compaction)
        systemBoundaryEntry(),
        // Current session: no clearing action taken
        assistantTextEntry("Let me continue working on the feature.")
      )
      const result = await runHook({ transcriptContent: transcript })
      expect(result.blocked).toBe(true)
      expect(result.reason).toContain("pre-existing")
    })

    test("dismissal in prior session cleared by fix in current session allows", async () => {
      const transcript = makeTranscript(
        // Prior session: diagnostic + dismissal
        shellCommandEntry("bun run lint"),
        toolResultEntry("src/foo.ts:10:5 warning: Unused variable\n✖ 1 problem"),
        assistantTextEntry("This warning is pre-existing."),
        // Session boundary (compaction)
        systemBoundaryEntry(),
        // Current session: fix applied
        editToolEntry("src/foo.ts", "const x = 1", "")
      )
      const result = await runHook({ transcriptContent: transcript })
      expect(result.blocked).toBe(false)
    })

    test("dismissal in prior session cleared by clean lint in current session allows", async () => {
      const transcript = makeTranscript(
        // Prior session: diagnostic + dismissal
        shellCommandEntry("bun run lint"),
        toolResultEntry("src/foo.ts:10:5 error: Missing return\n✖ 1 problem"),
        assistantTextEntry("This error is not introduced by our changes."),
        // Session boundary (compaction)
        systemBoundaryEntry(),
        // Current session: clean lint output resets
        shellCommandEntry("bun run lint"),
        toolResultEntry("All checks passed! No errors.")
      )
      const result = await runHook({ transcriptContent: transcript })
      expect(result.blocked).toBe(false)
    })
  })
})
