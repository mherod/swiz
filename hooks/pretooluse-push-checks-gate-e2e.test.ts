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
import { describe, expect, it, test } from "bun:test"
import { writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { type AdvisoryHookResult, useTempDir } from "../src/utils/test-utils.ts"

const HOOK_PATH = resolve(process.cwd(), "hooks/pretooluse-push-checks-gate.ts")

// ─── Temp dir lifecycle ──────────────────────────────────────────────────────

const _tmp = useTempDir()
async function makeTempDir(suffix = ""): Promise<string> {
  return _tmp.create(`push-gate-e2e${suffix}-`)
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
    await writeFile(this.path, `${this.lines.join("\n")}\n`)
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
    await writeFile(this.path, `${this.lines.join("\n")}\n`)
  }

  get commandCount(): number {
    return this.lines.length
  }
}

// ─── Hook runner ─────────────────────────────────────────────────────────────

async function runGate(opts: {
  pushCommand: string
  transcriptPath: string
}): Promise<AdvisoryHookResult> {
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
  void proc.stdin.write(payload)
  void proc.stdin.end()
  const out = await new Response(proc.stdout).text()
  await proc.exited

  if (!out.trim()) {
    return { blocked: false, reason: "", advisory: false }
  }
  const parsed = JSON.parse(out.trim())
  const hso = parsed?.hookSpecificOutput
  const decision = hso?.permissionDecision ?? parsed?.decision
  const reason = hso?.permissionDecisionReason ?? parsed?.reason ?? ""
  return {
    blocked: decision === "deny",
    reason,
    advisory: decision === "allow" && !!reason,
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
      expect(result.blocked).toBe(false)
      expect(result.advisory).toBe(true)
      expect(result.reason).toContain("git branch --show-current")
      expect(result.reason).toContain("gh pr list")
    }

    // ── Stage 2: Unrelated work in transcript — still advisory ─────────────
    await t.appendBashCommand("git status")
    await t.appendBashCommand("bun test")
    await t.appendOtherTool("Read")
    await t.appendBashCommand("git log --oneline -5")
    {
      const result = await runGate({
        pushCommand: "git push origin main",
        transcriptPath,
      })
      expect(result.blocked).toBe(false)
      expect(result.advisory).toBe(true)
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
      expect(result.blocked).toBe(false)
      expect(result.advisory).toBe(true)
      // Branch check done — should NOT mention it as missing
      expect(result.reason).not.toContain("Branch check (not run yet)")
      // PR check still required
      expect(result.reason).toContain("gh pr list")
    }

    // ── Stage 4: More unrelated work — advisory still holds ───────────────────
    await t.appendBashCommand("git diff --stat")
    await t.appendOtherTool("Edit")
    await t.appendBashCommand("bun test hooks/some.test.ts")
    {
      const result = await runGate({
        pushCommand: "git push origin main",
        transcriptPath,
      })
      expect(result.blocked).toBe(false)
      expect(result.advisory).toBe(true)
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
    expect(result.blocked).toBe(false)
    expect(result.advisory).toBe(true)
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
    expect(result.blocked).toBe(false)
    expect(result.advisory).toBe(true)
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
    expect(result.blocked).toBe(false)
    expect(result.advisory).toBe(true)
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
    expect(result.blocked).toBe(false)
    expect(result.advisory).toBe(true)
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
    expect(result.blocked).toBe(false)
    expect(result.advisory).toBe(true)
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

    const result = await runGate({ pushCommand: "git push origin main", transcriptPath })
    expect(result.blocked).toBe(false)
    expect(result.advisory).toBe(true)
  })
})

describe("E2E: push-checks-gate escaped/multiline/truncated JSON payload hardening", () => {
  /** Build a single assistant Bash tool_use JSONL line. */
  function bashEntry(command: string): string {
    return JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", name: "Bash", input: { command } }],
      },
    })
  }

  test("commands with escaped quotes are parsed correctly", async () => {
    const dir = await makeTempDir("-escaped")
    const transcriptPath = join(dir, "transcript.jsonl")

    // Commands that contain escaped quotes — JSON.stringify handles this safely
    const lines = [
      bashEntry('git branch --show-current  # "check current branch"'),
      bashEntry("gh pr list --state open --head main  # check PR's"),
    ]
    await writeFile(transcriptPath, lines.join("\n"))

    const result = await runGate({ pushCommand: "git push origin main", transcriptPath })
    expect(result.blocked).toBe(false)
  })

  test("backslash-continuation commands ARE normalised and satisfy the gate", async () => {
    const dir = await makeTempDir("-backslash")
    const transcriptPath = join(dir, "transcript.jsonl")

    // Shell backslash-newline continuation is normalised to a space before
    // regex matching, so `git branch \<newline>  --show-current` is treated
    // identically to `git branch --show-current`.
    const lines = [
      bashEntry("git branch \\\n  --show-current"),
      bashEntry("gh pr list --state open \\\n  --head main"),
    ]
    await writeFile(transcriptPath, lines.join("\n"))

    const result = await runGate({ pushCommand: "git push origin main", transcriptPath })
    expect(result.blocked).toBe(false)
  })

  test("check commands embedded in a semicolon-chained pipeline are recognised", async () => {
    const dir = await makeTempDir("-semicolon")
    const transcriptPath = join(dir, "transcript.jsonl")

    // Real-world: checks bundled with other commands in one Bash call
    const lines = [
      bashEntry("git log origin/main..HEAD --oneline && git branch --show-current"),
      bashEntry("git remote get-url origin; gh pr list --state open --head main"),
    ]
    await writeFile(transcriptPath, lines.join("\n"))

    const result = await runGate({ pushCommand: "git push origin main", transcriptPath })
    expect(result.blocked).toBe(false)
  })

  test("truncated JSON at end of file does not crash the hook", async () => {
    const dir = await makeTempDir("-truncated")
    const transcriptPath = join(dir, "transcript.jsonl")

    // Valid entries followed by a truncated (incomplete) JSON line
    const lines = [
      bashEntry("git branch --show-current"),
      bashEntry("gh pr list --state open --head main"),
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"git pu', // truncated
    ]
    await writeFile(transcriptPath, lines.join("\n"))
    const result = await runGate({ pushCommand: "git push origin main", transcriptPath })
    expect(result.blocked).toBe(false)
  })
  test("assistant message with multiple tool_use blocks in one content array", async () => {
    const dir = await makeTempDir("-multi-block")
    const transcriptPath = join(dir, "transcript.jsonl")
    // Claude sometimes emits multiple tool calls in a single assistant message
    const entry = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "Bash", input: { command: "git branch --show-current" } },
          { type: "text", text: "Let me also check for open PRs." },
          {
            type: "tool_use",
            name: "Bash",
            input: { command: "gh pr list --state open --head main" },
          },
        ],
      },
    })
    await writeFile(transcriptPath, `${entry}\n`)
    const result = await runGate({ pushCommand: "git push origin main", transcriptPath })
    expect(result.blocked).toBe(false)
  })
  test("unicode and special characters in commands do not confuse the parser", async () => {
    const dir = await makeTempDir("-unicode")
    const transcriptPath = join(dir, "transcript.jsonl")
    const lines = [
      // Surrounding noise with unicode, but the checks are present
      bashEntry("echo '🚀 deploying…'; git branch --show-current"),
      bashEntry("gh pr list --state open --head main  # ✅"),
    ]
    await writeFile(transcriptPath, lines.join("\n"))
    const result = await runGate({ pushCommand: "git push origin main", transcriptPath })
    expect(result.blocked).toBe(false)
  })
  test("--show-current-upstream does NOT satisfy the branch gate", async () => {
    const dir = await makeTempDir("-substring")
    const transcriptPath = join(dir, "transcript.jsonl")
    // 'git branch --show-current-upstream' contains '--show-current' as a prefix.
    // \b alone would match here because '-' is \W, creating a false positive.
    // The (?!\S) lookahead in BRANCH_CHECK_RE prevents this: '--show-current'
    // must be followed by whitespace or end-of-string, not '-upstream'.
    const lines = [
      bashEntry("git branch --show-current-upstream 2>/dev/null || git branch"),
      bashEntry("gh pr list --state open --head main"),
    ]
    await writeFile(transcriptPath, lines.join("\n"))
    const result = await runGate({ pushCommand: "git push origin main", transcriptPath })
    expect(result.blocked).toBe(false)
    expect(result.advisory).toBe(true)
    expect(result.reason).toContain("git branch --show-current")
  })
})
const IS_BUN = !!process.versions.bun

describe("Bun eager-buffering behavior — pipe-drain correctness", () => {
  const DEADLOCK_VOLUME = 3 * 65_536

  const SCRIPT = [
    `process.stderr.write("E".repeat(${DEADLOCK_VOLUME}));`,
    `process.stdout.write("O".repeat(${DEADLOCK_VOLUME}));`,
  ].join(" ")

  it.skipIf(!IS_BUN)(
    "await proc.exited before reading completes immediately (proves eager buffering)",
    async () => {
      const proc = Bun.spawn(["bun", "-e", SCRIPT], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      })
      void proc.stdin.end()

      await proc.exited

      const stdout = await new Response(proc.stdout).text()
      const stderr = await new Response(proc.stderr).text()

      expect(stdout).toHaveLength(DEADLOCK_VOLUME)
      expect(stderr).toHaveLength(DEADLOCK_VOLUME)
      expect(proc.exitCode).toBe(0)
    }
  )

  it.skipIf(!IS_BUN)(
    "sequential reads complete without deadlock in Bun (cross-runtime unsafe pattern)",
    async () => {
      const proc = Bun.spawn(["bun", "-e", SCRIPT], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      })
      void proc.stdin.end()

      let capturedStdout = ""
      let capturedStderr = ""

      const result = await Promise.race([
        (async () => {
          capturedStdout = await new Response(proc.stdout).text()
          capturedStderr = await new Response(proc.stderr).text()
          await proc.exited
          return "completed" as const
        })(),
        new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 3_000)),
      ])

      expect(result).toBe("completed")
      // Sequential reads return full data when Bun's eager buffering is active
      expect(capturedStdout).toHaveLength(DEADLOCK_VOLUME)
      expect(capturedStderr).toHaveLength(DEADLOCK_VOLUME)
    },
    8_000
  )

  it("concurrent Promise.all drain works — the cross-runtime safe pattern", async () => {
    const proc = Bun.spawn(["bun", "-e", SCRIPT], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    void proc.stdin.end()

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    await proc.exited

    expect(stdout).toHaveLength(DEADLOCK_VOLUME)
    expect(stderr).toHaveLength(DEADLOCK_VOLUME)
    expect(proc.exitCode).toBe(0)
  })
})

describe("Promise.all drain enforcement — cross-runtime portability guard", () => {
  it("hook source files must use Promise.all for concurrent stdout/stderr drain", async () => {
    // Collect all non-test *.ts files in the hooks directory.
    const hookFiles: string[] = []
    for await (const f of new Bun.Glob("*.ts").scan({ cwd: import.meta.dir, absolute: true })) {
      if (!f.endsWith(".test.ts")) hookFiles.push(f)
    }

    // Detect sequential drain: two separate awaits on proc.stdout and proc.stderr
    // (in either order) within ~500 chars, without a Promise.all wrapping them.
    const SEQ_DRAIN_RE =
      /await new Response\(proc\.(stdout|stderr)\)\.text\(\)([\s\S]{1,500}?)await new Response\(proc\.(stdout|stderr)\)\.text\(\)/g

    for (const file of hookFiles) {
      const src = await Bun.file(file).text()
      for (const m of src.matchAll(SEQ_DRAIN_RE)) {
        const [, first, , second] = m
        if (first === second) continue // same stream twice — not a cross-drain pattern
        // Check that a Promise.all wraps the pair (look up to 300 chars before the match)
        const before = src.slice(Math.max(0, (m.index ?? 0) - 300), m.index)
        if (!before.includes("Promise.all(")) {
          const relPath = file.slice(import.meta.dir.length + 1)
          throw new Error(
            `${relPath}: sequential ${first}/${second} drain detected outside Promise.all. ` +
              `Replace with:\n\n` +
              `  const [stdout, stderr] = await Promise.all([\n` +
              `    new Response(proc.stdout).text(),\n` +
              `    new Response(proc.stderr).text(),\n` +
              `  ])`
          )
        }
      }
    }
  })

  // Tripwire: runs ONLY outside Bun. Immediately fails to prevent misuse of
  // the Bun-specific sequential drain patterns documented in this file.
  it.skipIf(IS_BUN)(
    "NON-BUN RUNTIME DETECTED: sequential drain deadlocks here — enforce Promise.all",
    () => {
      throw new Error(
        "This test suite is running outside Bun. " +
          "Sequential proc.stdout / proc.stderr drain will deadlock when output exceeds " +
          "the OS pipe buffer (macOS/Linux: 65 536 bytes). " +
          "Always use Promise.all for concurrent drain in cross-runtime code."
      )
    }
  )
})

describe("pretooluse-no-as-any — NFKC homoglyph bypass", () => {
  const HOOK_PATH = join(import.meta.dir, "pretooluse-ts-quality.ts")

  async function runHookPayload(payload: object): Promise<{ stdout: string; exitCode: number }> {
    const proc = Bun.spawn(["bun", HOOK_PATH], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    void proc.stdin.write(JSON.stringify(payload))
    void proc.stdin.end()
    const stdout = await new Response(proc.stdout).text()
    await proc.exited
    return { stdout, exitCode: proc.exitCode ?? -1 }
  }

  it("blocks fullwidth 'as any' bypass (NFKC → 'as any')", async () => {
    // U+FF41 FULLWIDTH LATIN SMALL LETTER A, U+FF53 FULLWIDTH LATIN SMALL LETTER S
    const fwAs = String.fromCodePoint(0xff41) + String.fromCodePoint(0xff53)
    const { stdout } = await runHookPayload({
      tool_name: "Edit",
      tool_input: {
        file_path: "src/x.ts",
        old_string: "const x = 1",
        new_string: `const x = getValue() ${fwAs} any`,
      },
    })
    const parsed = JSON.parse(stdout)
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("deny")
  })
})
