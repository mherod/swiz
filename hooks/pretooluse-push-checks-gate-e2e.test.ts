/**
 * End-to-end tests for pretooluse-push-checks-gate.ts.
 *
 * Strategy: build a real JSONL transcript file that grows across each test
 * step — exactly as a live Claude Code session would — then spawn the hook as
 * a subprocess and verify the block/allow decision at each stage.
 *
 * This proves the gate works against real transcript parsing, not just the
 * unit-level regex helpers.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const HOOK_PATH = resolve(process.cwd(), "hooks/pretooluse-push-checks-gate.ts")

// ─── Temp dir lifecycle ──────────────────────────────────────────────────────

const tempDirs: string[] = []

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    await rm(dir, { recursive: true, force: true })
  }
})

async function makeTempDir(suffix = ""): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `push-gate-e2e${suffix}-`))
  tempDirs.push(dir)
  return dir
}

// ─── Transcript builder ──────────────────────────────────────────────────────

/**
 * Represents a growing session transcript on disk.
 * Append bash commands to simulate the agent's tool call history.
 */
class SessionTranscript {
  readonly path: string
  private lines: string[] = []

  constructor(path: string) {
    this.path = path
  }

  /** Record a Bash tool_use entry in the transcript (assistant message). */
  async appendBashCommand(command: string): Promise<void> {
    const entry = JSON.stringify({
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
    this.lines.push(entry)
    await writeFile(this.path, this.lines.join("\n") + "\n")
  }

  /** Record a non-bash tool_use entry (e.g. Read, Edit). */
  async appendOtherTool(toolName: string): Promise<void> {
    const entry = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", name: toolName, input: {} }],
      },
    })
    this.lines.push(entry)
    await writeFile(this.path, this.lines.join("\n") + "\n")
  }

  get commandCount(): number {
    return this.lines.length
  }
}

// ─── Hook runner ─────────────────────────────────────────────────────────────

interface HookResult {
  blocked: boolean
  reason: string
}

async function runGate(opts: { pushCommand: string; transcriptPath: string }): Promise<HookResult> {
  const payload = JSON.stringify({
    tool_name: "Bash",
    tool_input: { command: opts.pushCommand },
    transcript_path: opts.transcriptPath,
    session_id: "e2e-test",
    cwd: "/tmp",
  })

  const proc = Bun.spawn(["bun", HOOK_PATH], {
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
  return {
    blocked: (hso?.permissionDecision ?? parsed?.decision) === "deny",
    reason: hso?.permissionDecisionReason ?? parsed?.reason ?? "",
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("E2E: push-checks-gate progressive session simulation", () => {
  test("gate blocks push at every stage until both checks are present", async () => {
    const dir = await makeTempDir()
    const transcriptPath = join(dir, "transcript.jsonl")
    const t = new SessionTranscript(transcriptPath)

    // ── Stage 1: Empty transcript — both checks missing ───────────────────
    {
      const result = await runGate({
        pushCommand: "git push origin main",
        transcriptPath,
      })
      expect(result.blocked).toBe(true)
      expect(result.reason).toContain("git branch --show-current")
      expect(result.reason).toContain("gh pr list")
    }

    // ── Stage 2: Unrelated work in transcript — still blocked ─────────────
    await t.appendBashCommand("git status")
    await t.appendBashCommand("bun test")
    await t.appendOtherTool("Read")
    await t.appendBashCommand("git log --oneline -5")
    {
      const result = await runGate({
        pushCommand: "git push origin main",
        transcriptPath,
      })
      expect(result.blocked).toBe(true)
      expect(result.reason).toContain("git branch --show-current")
      expect(result.reason).toContain("gh pr list")
    }

    // ── Stage 3: Only branch check added — PR check still missing ─────────
    await t.appendBashCommand("git branch --show-current")
    {
      const result = await runGate({
        pushCommand: "git push origin main",
        transcriptPath,
      })
      expect(result.blocked).toBe(true)
      // Branch check done — should NOT mention it as missing
      expect(result.reason).not.toContain("Branch check (not run yet)")
      // PR check still required
      expect(result.reason).toContain("gh pr list")
    }

    // ── Stage 4: More unrelated work — gate still holds ───────────────────
    await t.appendBashCommand("git diff --stat")
    await t.appendOtherTool("Edit")
    await t.appendBashCommand("bun test hooks/some.test.ts")
    {
      const result = await runGate({
        pushCommand: "git push origin main",
        transcriptPath,
      })
      expect(result.blocked).toBe(true)
      expect(result.reason).toContain("gh pr list")
    }

    // ── Stage 5: PR check added — both checks now present → ALLOW ─────────
    await t.appendBashCommand("gh pr list --state open --head main")
    {
      const result = await runGate({
        pushCommand: "git push origin main",
        transcriptPath,
      })
      expect(result.blocked).toBe(false)
    }

    // ── Stage 6: More work added after checks — gate stays open ───────────
    await t.appendBashCommand("git add src/foo.ts")
    await t.appendBashCommand("git commit -m 'fix: something'")
    {
      const result = await runGate({
        pushCommand: "git push origin main",
        transcriptPath,
      })
      expect(result.blocked).toBe(false)
    }
  })

  test("wrong branch variants in transcript are rejected as insufficient", async () => {
    const dir = await makeTempDir("-wrong-branch")
    const transcriptPath = join(dir, "transcript.jsonl")
    const t = new SessionTranscript(transcriptPath)

    // Add the wrong branch commands (should not satisfy the gate)
    await t.appendBashCommand("git branch")
    await t.appendBashCommand("git branch -a")
    await t.appendBashCommand("git branch -vv")
    await t.appendBashCommand("git branch -d old-feature")
    // Add the PR check
    await t.appendBashCommand("gh pr list --state open --head main")

    const result = await runGate({
      pushCommand: "git push origin main",
      transcriptPath,
    })
    expect(result.blocked).toBe(true)
    expect(result.reason).toContain("git branch --show-current")
  })

  test("PR check without --head in transcript is rejected", async () => {
    const dir = await makeTempDir("-no-head")
    const transcriptPath = join(dir, "transcript.jsonl")
    const t = new SessionTranscript(transcriptPath)

    await t.appendBashCommand("git branch --show-current")
    // Missing --head — should not count
    await t.appendBashCommand("gh pr list --state open")
    await t.appendBashCommand("gh pr list")

    const result = await runGate({
      pushCommand: "git push origin main",
      transcriptPath,
    })
    expect(result.blocked).toBe(true)
    expect(result.reason).toContain("gh pr list")
  })

  test("force push variant is also gated end-to-end", async () => {
    const dir = await makeTempDir("-force")
    const transcriptPath = join(dir, "transcript.jsonl")

    // Empty transcript
    const result = await runGate({
      pushCommand: "git push --force-with-lease origin main",
      transcriptPath,
    })
    expect(result.blocked).toBe(true)
  })

  test("non-push commands pass through regardless of transcript state", async () => {
    const dir = await makeTempDir("-passthrough")
    const transcriptPath = join(dir, "transcript.jsonl")

    // No checks in transcript — but command is not a push
    for (const cmd of ["git status", "git commit -m 'wip'", "bun test", "gh run list"]) {
      const result = await runGate({ pushCommand: cmd, transcriptPath })
      expect(result.blocked).toBe(false)
    }
  })
})

describe("E2E: push-checks-gate transcript resilience", () => {
  test("malformed JSONL lines are skipped without crashing", async () => {
    const dir = await makeTempDir("-malformed")
    const transcriptPath = join(dir, "transcript.jsonl")

    // Mix valid entries with malformed lines
    const lines = [
      "not json at all",
      "{broken json",
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Bash", input: { command: "git branch --show-current" } },
          ],
        },
      }),
      "",
      "   ",
      "{]invalid[}",
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "Bash",
              input: { command: "gh pr list --state open --head main" },
            },
          ],
        },
      }),
    ]
    await writeFile(transcriptPath, lines.join("\n"))

    // Valid checks are present despite surrounding garbage — should allow
    const result = await runGate({ pushCommand: "git push origin main", transcriptPath })
    expect(result.blocked).toBe(false)
  })

  test("checks in user messages (not tool_use) do NOT satisfy the gate", async () => {
    const dir = await makeTempDir("-user-msgs")
    const transcriptPath = join(dir, "transcript.jsonl")

    // The check commands appear as user message text, not as Bash tool calls
    const lines = [
      JSON.stringify({ type: "user", message: { content: "git branch --show-current" } }),
      JSON.stringify({ type: "user", message: { content: "gh pr list --state open --head main" } }),
    ]
    await writeFile(transcriptPath, lines.join("\n"))

    const result = await runGate({ pushCommand: "git push origin main", transcriptPath })
    expect(result.blocked).toBe(true)
  })

  test("checks in tool_result entries (not tool_use) do NOT satisfy the gate", async () => {
    const dir = await makeTempDir("-tool-result")
    const transcriptPath = join(dir, "transcript.jsonl")

    // Simulates the result content of a prior Bash call containing the commands
    const lines = [
      JSON.stringify({
        type: "tool",
        content: [
          {
            type: "tool_result",
            content: "git branch --show-current\nmain\ngh pr list --state open --head main",
          },
        ],
      }),
    ]
    await writeFile(transcriptPath, lines.join("\n"))

    const result = await runGate({ pushCommand: "git push origin main", transcriptPath })
    expect(result.blocked).toBe(true)
  })

  test("checks buried early in a large transcript are still found", async () => {
    const dir = await makeTempDir("-large")
    const transcriptPath = join(dir, "transcript.jsonl")
    const t = new SessionTranscript(transcriptPath)

    // Both checks appear early
    await t.appendBashCommand("git branch --show-current")
    await t.appendBashCommand("gh pr list --state open --head main")

    // Followed by many unrelated commands
    for (let i = 0; i < 50; i++) {
      await t.appendBashCommand(`bun test hooks/hook-${i}.test.ts`)
    }

    const result = await runGate({ pushCommand: "git push origin main", transcriptPath })
    expect(result.blocked).toBe(false)
  })

  test("non-Bash tool calls with matching text in input do NOT satisfy the gate", async () => {
    const dir = await makeTempDir("-non-bash")
    const transcriptPath = join(dir, "transcript.jsonl")

    // Read/Edit tools whose input happens to contain the check strings
    const lines = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "Read",
              input: { file_path: "/tmp/notes.md", command: "git branch --show-current" },
            },
          ],
        },
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "Edit",
              input: { old_string: "gh pr list --state open --head main" },
            },
          ],
        },
      }),
    ]
    await writeFile(transcriptPath, lines.join("\n"))

    // Non-Bash tools must not satisfy the gate even if their input contains the strings
    const result = await runGate({ pushCommand: "git push origin main", transcriptPath })
    expect(result.blocked).toBe(true)
  })
})
