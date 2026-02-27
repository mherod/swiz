import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface HookResult {
  decision?: string
  reason?: string
  rawOutput: string
}

const BUN_EXE = Bun.which("bun") ?? "bun"

const tempDirs: string[] = []

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (!dir) continue
    await rm(dir, { recursive: true, force: true })
  }
})

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "swiz-auto-continue-"))
  tempDirs.push(dir)
  return dir
}

/** Creates a fake `agent` binary that prints `output` and exits with `exitCode`. */
async function createFakeAgent(binDir: string, output: string, exitCode = 0): Promise<void> {
  const script = `#!/bin/sh\nprintf '%s' '${output.replace(/'/g, "'\\''")}'\nexit ${exitCode}\n`
  const path = join(binDir, "agent")
  await writeFile(path, script)
  await chmod(path, 0o755)
}

/** Creates a fake `agent` binary that sleeps for `delaySecs` then prints output.
 * Uses `exec` so that sleep becomes the main process — SIGTERM/SIGKILL hit it
 * directly and close the pipe immediately instead of waiting for sleep to finish. */
async function createSlowFakeAgent(
  binDir: string,
  _output: string,
  delaySecs: number
): Promise<void> {
  // exec replaces the shell with sleep, so kill signals hit sleep directly
  const script = `#!/bin/sh\nexec sleep ${delaySecs}\n`
  const path = join(binDir, "agent")
  await writeFile(path, script)
  await chmod(path, 0o755)
}

/** Builds a minimal JSONL transcript with the given number of tool calls and a user turn. */
function buildTranscript(toolCallCount: number, userMessage = "What is the status?"): string {
  const lines: string[] = []
  // One user turn
  lines.push(JSON.stringify({ type: "user", message: { content: userMessage } }))
  // Assistant turns with tool_use blocks
  for (let i = 0; i < toolCallCount; i++) {
    lines.push(
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name: "Read", id: `t${i}`, input: {} }],
        },
      })
    )
  }
  return `${lines.join("\n")}\n`
}

async function runHook({
  transcriptContent,
  binDir,
  stopHookActive = false,
  extraEnv = {},
  cwd,
}: {
  transcriptContent: string
  binDir: string
  stopHookActive?: boolean
  extraEnv?: Record<string, string>
  cwd?: string
}): Promise<HookResult> {
  const workDir = await createTempDir()
  const transcriptPath = join(workDir, "transcript.jsonl")
  await writeFile(transcriptPath, transcriptContent)

  const hookCwd = cwd ?? workDir

  const payload = JSON.stringify({
    transcript_path: transcriptPath,
    stop_hook_active: stopHookActive,
    session_id: "test-session",
    cwd: hookCwd,
  })

  const { CLAUDECODE: _cc, ...cleanEnv } = process.env
  const proc = Bun.spawn([BUN_EXE, "hooks/stop-auto-continue.ts"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...cleanEnv,
      PATH: `${binDir}:/bin:/usr/bin`,
      ...extraEnv,
    },
  })
  proc.stdin.write(payload)
  proc.stdin.end()

  const rawOutput = await new Response(proc.stdout).text()
  await proc.exited

  if (!rawOutput.trim()) return { rawOutput }

  try {
    const parsed = JSON.parse(rawOutput.trim())
    return {
      decision: parsed.decision,
      reason: parsed.reason,
      rawOutput,
    }
  } catch {
    return { rawOutput }
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("stop-auto-continue", () => {
  test("blocks with AI suggestion for a substantive session", async () => {
    const binDir = await createTempDir()
    await createFakeAgent(binDir, "Commit the changes to main")

    const result = await runHook({
      transcriptContent: buildTranscript(10),
      binDir,
    })

    expect(result.decision).toBe("block")
    expect(result.reason).toContain("Commit the changes to main")
  })

  test("blocks even when stop_hook_active is true (unconditional)", async () => {
    const binDir = await createTempDir()
    await createFakeAgent(binDir, "Run the test suite")

    const result = await runHook({
      transcriptContent: buildTranscript(10),
      binDir,
      stopHookActive: true,
    })

    expect(result.decision).toBe("block")
    expect(result.reason).toContain("Run the test suite")
  })

  test("allows stop for trivial sessions (< 5 tool calls)", async () => {
    const binDir = await createTempDir()
    await createFakeAgent(binDir, "Should not appear")

    const result = await runHook({
      transcriptContent: buildTranscript(3),
      binDir,
    })

    expect(result.decision).toBeUndefined()
  })

  test("allows stop when auto-continue is disabled in global swiz settings", async () => {
    const binDir = await createTempDir()
    await createFakeAgent(binDir, "Should not appear")

    const homeDir = await createTempDir()
    await mkdir(join(homeDir, ".swiz"), { recursive: true })
    await writeFile(join(homeDir, ".swiz", "settings.json"), '{\n  "autoContinue": false\n}\n')

    const result = await runHook({
      transcriptContent: buildTranscript(10),
      binDir,
      extraEnv: { HOME: homeDir },
    })

    expect(result.decision).toBeUndefined()
  })

  test("session override takes precedence over global setting", async () => {
    const binDir = await createTempDir()
    await createFakeAgent(binDir, "Run the linter")

    const homeDir = await createTempDir()
    await mkdir(join(homeDir, ".swiz"), { recursive: true })
    await writeFile(
      join(homeDir, ".swiz", "settings.json"),
      '{\n  "autoContinue": false,\n  "sessions": {\n    "test-session": {\n      "autoContinue": true\n    }\n  }\n}\n'
    )

    const result = await runHook({
      transcriptContent: buildTranscript(10),
      binDir,
      extraEnv: { HOME: homeDir },
    })

    expect(result.decision).toBe("block")
    expect(result.reason).toContain("Run the linter")
  })

  test("falls back to generic message when agent fails", async () => {
    const binDir = await createTempDir()
    // Agent always fails
    await createFakeAgent(binDir, "", 1)

    const result = await runHook({
      transcriptContent: buildTranscript(10),
      binDir,
    })

    expect(result.decision).toBe("block")
    expect(result.reason).toContain("identify the most critical incomplete task")
  })

  test("blocks with fallback guidance when no AI backend is available", async () => {
    // binDir has no agent binary
    const binDir = await createTempDir()

    const result = await runHook({
      transcriptContent: buildTranscript(10),
      binDir,
    })

    expect(result.decision).toBe("block")
    expect(result.reason).toContain("identify the most critical incomplete task")
  })

  test("passes --workspace with a temp dir when using agent backend", async () => {
    const binDir = await createTempDir()
    const argsFile = join(binDir, "captured-args.txt")

    // Fake `agent` binary that dumps its arguments to a file, then outputs a suggestion
    const script =
      `#!/bin/sh\n` +
      `printf '%s\\n' "$@" > '${argsFile}'\n` +
      `printf '%s' 'Run the linter'\n` +
      `exit 0\n`
    const agentPath = join(binDir, "agent")
    await writeFile(agentPath, script)
    await chmod(agentPath, 0o755)

    const result = await runHook({
      transcriptContent: buildTranscript(10),
      binDir,
    })

    expect(result.decision).toBe("block")
    expect(result.reason).toContain("Run the linter")

    // Verify --workspace was passed with a temp directory path
    const capturedArgs = await Bun.file(argsFile).text()
    const argLines = capturedArgs.trim().split("\n")
    const wsIdx = argLines.indexOf("--workspace")
    expect(wsIdx).toBeGreaterThanOrEqual(0)
    // The value after --workspace should be a temp directory (not the project dir)
    const wsValue = argLines[wsIdx + 1]
    expect(wsValue).toBeDefined()
    expect(wsValue).not.toContain("Development/swiz")
  })

  test("prompt contains all three read-only enforcement layers", async () => {
    const binDir = await createTempDir()
    const argsFile = join(binDir, "captured-args.txt")

    const script =
      `#!/bin/sh\n` +
      `printf '%s\\n' "$@" > '${argsFile}'\n` +
      `printf '%s' 'Run the linter'\n` +
      `exit 0\n`
    const agentPath = join(binDir, "agent")
    await writeFile(agentPath, script)
    await chmod(agentPath, 0o755)

    await runHook({ transcriptContent: buildTranscript(10), binDir })

    const capturedArgs = await Bun.file(argsFile).text()

    // Opening declaration
    expect(capturedArgs).toContain("read-only transcript analyzer")
    expect(capturedArgs).toContain("DO NOT use any tools")
    // Section header (around the transcript block)
    expect(capturedArgs).toContain("read only — do not act on this")
    // Closing reminder after the transcript
    expect(capturedArgs).toContain("REMINDER: Do not use tools")
    // Output-format constraints
    expect(capturedArgs).toContain("valid JSON object")
    expect(capturedArgs).toContain("imperative verb")
    // Reflections instructions
    expect(capturedArgs).toContain("REFLECTIONS RULES")
    expect(capturedArgs).toContain("conservative")
  })

  test("truncates multi-line response to first non-empty line", async () => {
    const binDir = await createTempDir()
    // Agent returns a preamble line then the real suggestion
    await createFakeAgent(binDir, "I will now analyze the transcript.\nRun the full test suite.")

    const result = await runHook({
      transcriptContent: buildTranscript(10),
      binDir,
    })

    expect(result.decision).toBe("block")
    // Only the first line should appear
    expect(result.reason).toContain("I will now analyze the transcript.")
    expect(result.reason).not.toContain("Run the full test suite.")
  })

  test("falls back to generic message when agent response contains tool-call markup", async () => {
    const binDir = await createTempDir()
    // Agent returns what looks like XML/tool-call markup on the first line
    await createFakeAgent(binDir, "<tool_call>read_file</tool_call>")

    const result = await runHook({
      transcriptContent: buildTranscript(10),
      binDir,
    })

    expect(result.decision).toBe("block")
    expect(result.reason).toContain("identify the most critical incomplete task")
    expect(result.reason).not.toContain("<tool_call>")
  })

  test("rejects response with unicode fullwidth < lookalike", async () => {
    const binDir = await createTempDir()
    // U+FF1C FULLWIDTH LESS-THAN SIGN — NFKC-normalises to ASCII <
    await createFakeAgent(binDir, "\uFF1Ctool_call\uFF1E")

    const result = await runHook({
      transcriptContent: buildTranscript(10),
      binDir,
    })

    expect(result.decision).toBe("block")
    expect(result.reason).toContain("identify the most critical incomplete task")
    expect(result.reason).not.toContain("\uFF1Ctool_call")
  })

  test("rejects response with zero-width joiner injected between < and tag name", async () => {
    const binDir = await createTempDir()
    // U+200D ZWJ between < and tag name would break /<\w/ without stripping
    await createFakeAgent(binDir, "<\u200Dtool_call>")

    const result = await runHook({
      transcriptContent: buildTranscript(10),
      binDir,
    })

    expect(result.decision).toBe("block")
    expect(result.reason).toContain("identify the most critical incomplete task")
    expect(result.reason).not.toContain("<\u200Dtool_call>")
  })

  test("rejects response with RTL override character before markup", async () => {
    const binDir = await createTempDir()
    // U+202E RIGHT-TO-LEFT OVERRIDE — ASCII < is still present, already caught
    await createFakeAgent(binDir, "\u202E<tool_call>")

    const result = await runHook({
      transcriptContent: buildTranscript(10),
      binDir,
    })

    expect(result.decision).toBe("block")
    expect(result.reason).toContain("identify the most critical incomplete task")
  })

  test("rejects response with CJK left angle bracket homoglyph 〈 (U+3008)", async () => {
    const binDir = await createTempDir()
    await createFakeAgent(binDir, "\u3008tool_call\u3009")

    const result = await runHook({
      transcriptContent: buildTranscript(10),
      binDir,
    })

    expect(result.decision).toBe("block")
    expect(result.reason).toContain("identify the most critical incomplete task")
    expect(result.reason).not.toContain("\u3008tool_call")
  })

  test("rejects response with single left-pointing angle quotation ‹ (U+2039)", async () => {
    const binDir = await createTempDir()
    await createFakeAgent(binDir, "\u2039tool_call\u203A")

    const result = await runHook({
      transcriptContent: buildTranscript(10),
      binDir,
    })

    expect(result.decision).toBe("block")
    expect(result.reason).toContain("identify the most critical incomplete task")
    expect(result.reason).not.toContain("\u2039tool_call")
  })

  test("rejects response with mathematical left angle bracket ⟨ (U+27E8)", async () => {
    const binDir = await createTempDir()
    await createFakeAgent(binDir, "\u27E8tool_call\u27E9")

    const result = await runHook({
      transcriptContent: buildTranscript(10),
      binDir,
    })

    expect(result.decision).toBe("block")
    expect(result.reason).toContain("identify the most critical incomplete task")
    expect(result.reason).not.toContain("\u27E8tool_call")
  })

  test("rejects response with modifier letter left arrowhead ˂ (U+02C2)", async () => {
    const binDir = await createTempDir()
    await createFakeAgent(binDir, "\u02C2tool_call\u02C3")

    const result = await runHook({ transcriptContent: buildTranscript(10), binDir })

    expect(result.decision).toBe("block")
    expect(result.reason).toContain("identify the most critical incomplete task")
    expect(result.reason).not.toContain("\u02C2tool_call")
  })

  test("rejects response with Canadian Syllabics PA ᐸ (U+1438)", async () => {
    const binDir = await createTempDir()
    await createFakeAgent(binDir, "\u1438tool_call\u1433")

    const result = await runHook({ transcriptContent: buildTranscript(10), binDir })

    expect(result.decision).toBe("block")
    expect(result.reason).toContain("identify the most critical incomplete task")
    expect(result.reason).not.toContain("\u1438tool_call")
  })

  test("rejects response with heavy left-pointing angle quotation ❮ (U+276E)", async () => {
    const binDir = await createTempDir()
    await createFakeAgent(binDir, "\u276Etool_call\u276F")

    const result = await runHook({ transcriptContent: buildTranscript(10), binDir })

    expect(result.decision).toBe("block")
    expect(result.reason).toContain("identify the most critical incomplete task")
    expect(result.reason).not.toContain("\u276Etool_call")
  })

  test("rejects response with small less-than sign ﹤ (U+FE64, NFKC→<)", async () => {
    const binDir = await createTempDir()
    await createFakeAgent(binDir, "\uFE64tool_call\uFE65")

    const result = await runHook({ transcriptContent: buildTranscript(10), binDir })

    expect(result.decision).toBe("block")
    expect(result.reason).toContain("identify the most critical incomplete task")
  })

  test("rejects response with heavy left-pointing angle bracket ❰ (U+2770)", async () => {
    const binDir = await createTempDir()
    await createFakeAgent(binDir, "\u2770tool_call\u2771")

    const result = await runHook({ transcriptContent: buildTranscript(10), binDir })

    expect(result.decision).toBe("block")
    expect(result.reason).toContain("identify the most critical incomplete task")
  })

  test("rejects response with mathematical left double angle bracket ⟪ (U+27EA)", async () => {
    const binDir = await createTempDir()
    await createFakeAgent(binDir, "\u27EAtool_call\u27EB")

    const result = await runHook({ transcriptContent: buildTranscript(10), binDir })

    expect(result.decision).toBe("block")
    expect(result.reason).toContain("identify the most critical incomplete task")
  })

  test("rejects response with left angle bracket with dot ⦑ (U+2991)", async () => {
    const binDir = await createTempDir()
    await createFakeAgent(binDir, "\u2991tool_call\u2992")

    const result = await runHook({ transcriptContent: buildTranscript(10), binDir })

    expect(result.decision).toBe("block")
    expect(result.reason).toContain("identify the most critical incomplete task")
  })

  test("rejects response with left-pointing curved angle bracket ⧼ (U+29FC)", async () => {
    const binDir = await createTempDir()
    await createFakeAgent(binDir, "\u29FCtool_call\u29FD")

    const result = await runHook({ transcriptContent: buildTranscript(10), binDir })

    expect(result.decision).toBe("block")
    expect(result.reason).toContain("identify the most critical incomplete task")
  })

  test("rejects response with leading-whitespace XML tag", async () => {
    const binDir = await createTempDir()
    await createFakeAgent(binDir, "  <tool_call>read_file</tool_call>")

    const result = await runHook({
      transcriptContent: buildTranscript(10),
      binDir,
    })

    expect(result.decision).toBe("block")
    expect(result.reason).toContain("identify the most critical incomplete task")
    expect(result.reason).not.toContain("<tool_call>")
  })

  test("rejects response with XML markup embedded after normal text", async () => {
    const binDir = await createTempDir()
    await createFakeAgent(binDir, "Run the tests <tool_call>bash</tool_call>")

    const result = await runHook({
      transcriptContent: buildTranscript(10),
      binDir,
    })

    expect(result.decision).toBe("block")
    expect(result.reason).toContain("identify the most critical incomplete task")
    expect(result.reason).not.toContain("<tool_call>")
  })

  test("skips empty lines and returns first non-empty clean line", async () => {
    const binDir = await createTempDir()
    await createFakeAgent(binDir, "\n\nRun the full test suite.")

    const result = await runHook({
      transcriptContent: buildTranscript(10),
      binDir,
    })

    expect(result.decision).toBe("block")
    expect(result.reason).toContain("Run the full test suite.")
  })

  // ─── Session task context tests ─────────────────────────────────────────────

  /** Creates a fake HOME tree with a tasks dir for "test-session" and returns the home path. */
  async function setupTasksDir(sessionId = "test-session"): Promise<string> {
    const fakeHome = await createTempDir()
    await mkdir(join(fakeHome, ".claude", "tasks", sessionId), { recursive: true })
    return fakeHome
  }

  /** Writes a single task JSON file into the session tasks dir. */
  async function writeTask(
    fakeHome: string,
    id: string,
    status: string,
    subject: string,
    sessionId = "test-session"
  ): Promise<void> {
    const tasksDir = join(fakeHome, ".claude", "tasks", sessionId)
    await writeFile(join(tasksDir, `${id}.json`), JSON.stringify({ id, status, subject }))
  }

  /** Returns a fake agent binDir that dumps args to a file and outputs a safe suggestion. */
  async function createArgCapturingAgent(binDir: string): Promise<string> {
    const argsFile = join(binDir, "captured-args.txt")
    const script =
      `#!/bin/sh\n` +
      `printf '%s\\n' "$@" > '${argsFile}'\n` +
      `printf '%s' 'Run the tests'\n` +
      `exit 0\n`
    const agentPath = join(binDir, "agent")
    await writeFile(agentPath, script)
    await chmod(agentPath, 0o755)
    return argsFile
  }

  test("omits SESSION TASKS section when tasks directory does not exist", async () => {
    const fakeHome = await createTempDir() // no .claude/tasks created
    const binDir = await createTempDir()
    const argsFile = await createArgCapturingAgent(binDir)

    await runHook({
      transcriptContent: buildTranscript(10),
      binDir,
      extraEnv: { HOME: fakeHome },
    })

    const capturedArgs = await Bun.file(argsFile).text()
    expect(capturedArgs).not.toContain("SESSION TASKS")
  })

  test("omits SESSION TASKS section when tasks directory is empty", async () => {
    const fakeHome = await setupTasksDir()
    const binDir = await createTempDir()
    const argsFile = await createArgCapturingAgent(binDir)

    await runHook({
      transcriptContent: buildTranscript(10),
      binDir,
      extraEnv: { HOME: fakeHome },
    })

    const capturedArgs = await Bun.file(argsFile).text()
    expect(capturedArgs).not.toContain("SESSION TASKS")
  })

  test("includes COMPLETED tasks in SESSION TASKS section", async () => {
    const fakeHome = await setupTasksDir()
    await writeTask(fakeHome, "1", "completed", "Fix the auth bug")
    await writeTask(fakeHome, "2", "completed", "Add unit tests")
    const binDir = await createTempDir()
    const argsFile = await createArgCapturingAgent(binDir)

    await runHook({
      transcriptContent: buildTranscript(10),
      binDir,
      extraEnv: { HOME: fakeHome },
    })

    const capturedArgs = await Bun.file(argsFile).text()
    expect(capturedArgs).toContain("SESSION TASKS")
    expect(capturedArgs).toContain("COMPLETED:")
    expect(capturedArgs).toContain("Fix the auth bug (#1)")
    expect(capturedArgs).toContain("Add unit tests (#2)")
  })

  test("includes IN PROGRESS tasks in SESSION TASKS section", async () => {
    const fakeHome = await setupTasksDir()
    await writeTask(fakeHome, "3", "in_progress", "Refactor CLI entry")
    const binDir = await createTempDir()
    const argsFile = await createArgCapturingAgent(binDir)

    await runHook({
      transcriptContent: buildTranscript(10),
      binDir,
      extraEnv: { HOME: fakeHome },
    })

    const capturedArgs = await Bun.file(argsFile).text()
    expect(capturedArgs).toContain("SESSION TASKS")
    expect(capturedArgs).toContain("IN PROGRESS:")
    expect(capturedArgs).toContain("Refactor CLI entry (#3)")
  })

  test("excludes pending tasks from SESSION TASKS section", async () => {
    const fakeHome = await setupTasksDir()
    await writeTask(fakeHome, "1", "completed", "Done task")
    await writeTask(fakeHome, "2", "pending", "Not started yet")
    const binDir = await createTempDir()
    const argsFile = await createArgCapturingAgent(binDir)

    await runHook({
      transcriptContent: buildTranscript(10),
      binDir,
      extraEnv: { HOME: fakeHome },
    })

    const capturedArgs = await Bun.file(argsFile).text()
    expect(capturedArgs).toContain("Done task (#1)")
    expect(capturedArgs).not.toContain("Not started yet")
  })

  test("shows both IN PROGRESS and COMPLETED in mixed-status session", async () => {
    const fakeHome = await setupTasksDir()
    await writeTask(fakeHome, "1", "completed", "Write tests")
    await writeTask(fakeHome, "2", "in_progress", "Fix type errors")
    await writeTask(fakeHome, "3", "pending", "Deploy to prod")
    const binDir = await createTempDir()
    const argsFile = await createArgCapturingAgent(binDir)

    await runHook({
      transcriptContent: buildTranscript(10),
      binDir,
      extraEnv: { HOME: fakeHome },
    })

    const capturedArgs = await Bun.file(argsFile).text()
    expect(capturedArgs).toContain("IN PROGRESS:")
    expect(capturedArgs).toContain("Fix type errors (#2)")
    expect(capturedArgs).toContain("COMPLETED:")
    expect(capturedArgs).toContain("Write tests (#1)")
    expect(capturedArgs).not.toContain("Deploy to prod")
  })

  test("silently skips malformed JSON task files and shows valid tasks", async () => {
    const fakeHome = await setupTasksDir()
    await writeTask(fakeHome, "1", "completed", "Valid task")
    // Write a malformed JSON file alongside the valid one
    await writeFile(
      join(fakeHome, ".claude", "tasks", "test-session", "bad.json"),
      "{ this is not valid json }"
    )
    const binDir = await createTempDir()
    const argsFile = await createArgCapturingAgent(binDir)

    await runHook({
      transcriptContent: buildTranscript(10),
      binDir,
      extraEnv: { HOME: fakeHome },
    })

    const capturedArgs = await Bun.file(argsFile).text()
    expect(capturedArgs).toContain("Valid task (#1)")
    // Malformed file should not cause an error message or crash
    expect(capturedArgs).not.toContain("not valid json")
  })

  test("silently skips task file with null id", async () => {
    const fakeHome = await setupTasksDir()
    await writeTask(fakeHome, "1", "completed", "Real task")
    // Task with literal null id (as produced by some serialization paths)
    await writeFile(
      join(fakeHome, ".claude", "tasks", "test-session", "nullid.json"),
      JSON.stringify({ id: "null", status: "completed", subject: "Ghost task" })
    )
    const binDir = await createTempDir()
    const argsFile = await createArgCapturingAgent(binDir)

    await runHook({
      transcriptContent: buildTranscript(10),
      binDir,
      extraEnv: { HOME: fakeHome },
    })

    const capturedArgs = await Bun.file(argsFile).text()
    expect(capturedArgs).toContain("Real task (#1)")
    expect(capturedArgs).not.toContain("Ghost task")
  })

  test("ignores non-.json files in tasks directory", async () => {
    const fakeHome = await setupTasksDir()
    await writeTask(fakeHome, "1", "completed", "Real task")
    // Audit log and other non-json files should not be read as tasks
    await writeFile(
      join(fakeHome, ".claude", "tasks", "test-session", ".audit-log.jsonl"),
      JSON.stringify({ action: "create", taskId: "99", subject: "Should be ignored" })
    )
    const binDir = await createTempDir()
    const argsFile = await createArgCapturingAgent(binDir)

    await runHook({
      transcriptContent: buildTranscript(10),
      binDir,
      extraEnv: { HOME: fakeHome },
    })

    const capturedArgs = await Bun.file(argsFile).text()
    expect(capturedArgs).toContain("Real task (#1)")
    expect(capturedArgs).not.toContain("Should be ignored")
  })

  test("times out slow backend and falls back to generic message", async () => {
    const binDir = await createTempDir()
    await createSlowFakeAgent(binDir, "This should never appear", 30)

    const result = await runHook({
      transcriptContent: buildTranscript(10),
      binDir,
      extraEnv: {
        ATTEMPT_TIMEOUT_MS: "500",
      },
    })

    expect(result.decision).toBe("block")
    expect(result.reason).toContain("identify the most critical incomplete task")
    expect(result.reason).not.toContain("This should never appear")
  }, 10_000)

  // ─── JSON response parsing tests ──────────────────────────────────────────

  test("parses JSON response with next step", async () => {
    const binDir = await createTempDir()
    const json = JSON.stringify({ next: "Run the full test suite", reflections: [] })
    await createFakeAgent(binDir, json)

    const result = await runHook({
      transcriptContent: buildTranscript(10),
      binDir,
    })

    expect(result.decision).toBe("block")
    expect(result.reason).toContain("Run the full test suite")
  })

  test("falls back to plain text when agent outputs non-JSON", async () => {
    const binDir = await createTempDir()
    await createFakeAgent(binDir, "Commit all pending changes now")

    const result = await runHook({
      transcriptContent: buildTranscript(10),
      binDir,
    })

    expect(result.decision).toBe("block")
    expect(result.reason).toContain("Commit all pending changes now")
  })

  test("strips markdown fences from JSON response", async () => {
    const binDir = await createTempDir()
    const json = `\`\`\`json\n${JSON.stringify({ next: "Fix the type errors", reflections: [] })}\n\`\`\``
    await createFakeAgent(binDir, json)

    const result = await runHook({
      transcriptContent: buildTranscript(10),
      binDir,
    })

    expect(result.decision).toBe("block")
    expect(result.reason).toContain("Fix the type errors")
  })

  test("rejects markup in JSON next field and falls back", async () => {
    const binDir = await createTempDir()
    const json = JSON.stringify({ next: "<tool_call>bash</tool_call>", reflections: [] })
    await createFakeAgent(binDir, json)

    const result = await runHook({
      transcriptContent: buildTranscript(10),
      binDir,
    })

    expect(result.decision).toBe("block")
    expect(result.reason).toContain("identify the most critical incomplete task")
    expect(result.reason).not.toContain("<tool_call>")
  })

  test("filters out reflections containing XML markup", async () => {
    const binDir = await createTempDir()
    const json = JSON.stringify({
      next: "Run the tests",
      reflections: ["DO: Always use bun instead of npm", "<script>alert('xss')</script>"],
    })
    await createFakeAgent(binDir, json)

    // Setup memory dir
    const fakeHome = await createTempDir()
    const hookCwd = await createTempDir()
    const projectKey = hookCwd.replace(/\//g, "-")
    const memoryDir = join(fakeHome, ".claude", "projects", projectKey, "memory")
    await mkdir(memoryDir, { recursive: true })
    const memoryFile = join(memoryDir, "MEMORY.md")
    await writeFile(memoryFile, "# Memory\n")

    await runHook({
      transcriptContent: buildTranscript(10),
      binDir,
      cwd: hookCwd,
      extraEnv: { HOME: fakeHome },
    })

    const memory = await Bun.file(memoryFile).text()
    expect(memory).toContain("Always use bun instead of npm")
    expect(memory).not.toContain("script")
  })

  // ─── Memory writing tests ────────────────────────────────────────────────

  /** Sets up a fake HOME with a project memory dir matching the given cwd. */
  async function setupMemoryDir(
    fakeHome: string,
    hookCwd: string,
    initialContent = "# Memory\n"
  ): Promise<string> {
    const projectKey = hookCwd.replace(/\//g, "-")
    const memoryDir = join(fakeHome, ".claude", "projects", projectKey, "memory")
    await mkdir(memoryDir, { recursive: true })
    const memoryFile = join(memoryDir, "MEMORY.md")
    await writeFile(memoryFile, initialContent)
    return memoryFile
  }

  test("writes reflections to MEMORY.md", async () => {
    const binDir = await createTempDir()
    const json = JSON.stringify({
      next: "Run the tests",
      reflections: ["DO: Always use bun instead of npm", "DON'T: Use grep, prefer rg"],
    })
    await createFakeAgent(binDir, json)

    const fakeHome = await createTempDir()
    const hookCwd = await createTempDir()
    const memoryFile = await setupMemoryDir(fakeHome, hookCwd)

    await runHook({
      transcriptContent: buildTranscript(10),
      binDir,
      cwd: hookCwd,
      extraEnv: { HOME: fakeHome },
    })

    const memory = await Bun.file(memoryFile).text()
    expect(memory).toContain("## Confirmed Patterns")
    expect(memory).toContain("**DO**: Always use bun instead of npm")
    expect(memory).toContain("**DON'T**: Use grep, prefer rg")
  })

  test("deduplicates reflections against existing memory", async () => {
    const binDir = await createTempDir()
    const json = JSON.stringify({
      next: "Run the tests",
      reflections: ["DO: Always use bun instead of npm"],
    })
    await createFakeAgent(binDir, json)

    const fakeHome = await createTempDir()
    const hookCwd = await createTempDir()
    const memoryFile = await setupMemoryDir(
      fakeHome,
      hookCwd,
      "# Memory\n\n## Confirmed Patterns\n\n- **DO**: Always use bun instead of npm\n"
    )

    await runHook({
      transcriptContent: buildTranscript(10),
      binDir,
      cwd: hookCwd,
      extraEnv: { HOME: fakeHome },
    })

    const memory = await Bun.file(memoryFile).text()
    // Should appear exactly once (not duplicated)
    const matches = memory.match(/Always use bun instead of npm/g)
    expect(matches).toHaveLength(1)
  })

  test("appends to existing Confirmed Patterns section without duplicate header", async () => {
    const binDir = await createTempDir()
    const json = JSON.stringify({
      next: "Run the tests",
      reflections: ["DO: Prefer Bun.file over fs.readFile"],
    })
    await createFakeAgent(binDir, json)

    const fakeHome = await createTempDir()
    const hookCwd = await createTempDir()
    const memoryFile = await setupMemoryDir(
      fakeHome,
      hookCwd,
      "# Memory\n\n## Confirmed Patterns\n\n- **DO**: Use TypeScript exclusively\n"
    )

    await runHook({
      transcriptContent: buildTranscript(10),
      binDir,
      cwd: hookCwd,
      extraEnv: { HOME: fakeHome },
    })

    const memory = await Bun.file(memoryFile).text()
    // Should have exactly one "## Confirmed Patterns" header
    const headers = memory.match(/## Confirmed Patterns/g)
    expect(headers).toHaveLength(1)
    expect(memory).toContain("Prefer Bun.file over fs.readFile")
    expect(memory).toContain("Use TypeScript exclusively")
  })

  test("skips memory writing when no project dir exists", async () => {
    const binDir = await createTempDir()
    const json = JSON.stringify({
      next: "Run the tests",
      reflections: ["DO: Use bun exclusively"],
    })
    await createFakeAgent(binDir, json)

    const fakeHome = await createTempDir()
    // No project dir created — hook should not crash

    const result = await runHook({
      transcriptContent: buildTranscript(10),
      binDir,
      cwd: "/nonexistent/project/path",
      extraEnv: { HOME: fakeHome },
    })

    expect(result.decision).toBe("block")
    expect(result.reason).toContain("Run the tests")
  })

  test("skips reflections that are too short", async () => {
    const binDir = await createTempDir()
    const json = JSON.stringify({
      next: "Run the tests",
      reflections: ["short", "DO: Always use bun for running TypeScript files"],
    })
    await createFakeAgent(binDir, json)

    const fakeHome = await createTempDir()
    const hookCwd = await createTempDir()
    const memoryFile = await setupMemoryDir(fakeHome, hookCwd)

    await runHook({
      transcriptContent: buildTranscript(10),
      binDir,
      cwd: hookCwd,
      extraEnv: { HOME: fakeHome },
    })

    const memory = await Bun.file(memoryFile).text()
    expect(memory).not.toContain("short")
    expect(memory).toContain("Always use bun for running TypeScript files")
  })

  test("does not write reflections when memory file would exceed 200 lines", async () => {
    const binDir = await createTempDir()
    const json = JSON.stringify({
      next: "Run the tests",
      reflections: ["DO: This should not be written to memory"],
    })
    await createFakeAgent(binDir, json)

    const fakeHome = await createTempDir()
    const hookCwd = await createTempDir()
    // Create a memory file that's already at ~199 lines
    const longContent = `# Memory\n${"\n".repeat(198)}`
    const memoryFile = await setupMemoryDir(fakeHome, hookCwd, longContent)

    await runHook({
      transcriptContent: buildTranscript(10),
      binDir,
      cwd: hookCwd,
      extraEnv: { HOME: fakeHome },
    })

    const memory = await Bun.file(memoryFile).text()
    expect(memory).not.toContain("This should not be written")
  })

  test("does not write reflections when agent returns no reflections", async () => {
    const binDir = await createTempDir()
    const json = JSON.stringify({ next: "Run the tests", reflections: [] })
    await createFakeAgent(binDir, json)

    const fakeHome = await createTempDir()
    const hookCwd = await createTempDir()
    const memoryFile = await setupMemoryDir(fakeHome, hookCwd)

    await runHook({
      transcriptContent: buildTranscript(10),
      binDir,
      cwd: hookCwd,
      extraEnv: { HOME: fakeHome },
    })

    const memory = await Bun.file(memoryFile).text()
    expect(memory).toBe("# Memory\n")
  })

  test("formats reflections without prefix as DO directives", async () => {
    const binDir = await createTempDir()
    const json = JSON.stringify({
      next: "Run the tests",
      reflections: ["Always use Bun.spawn instead of child_process"],
    })
    await createFakeAgent(binDir, json)

    const fakeHome = await createTempDir()
    const hookCwd = await createTempDir()
    const memoryFile = await setupMemoryDir(fakeHome, hookCwd)

    await runHook({
      transcriptContent: buildTranscript(10),
      binDir,
      cwd: hookCwd,
      extraEnv: { HOME: fakeHome },
    })

    const memory = await Bun.file(memoryFile).text()
    expect(memory).toContain("- **DO**: Always use Bun.spawn instead of child_process")
  })

  // ─── skillAdvice prompt guard tests ──────────────────────────────────────

  test("prompt references /changelog skill when skill is installed", async () => {
    const binDir = await createTempDir()
    const argsFile = await createArgCapturingAgent(binDir)

    // Create a fake skill directory so skillExists("changelog") returns true
    const fakeHome = await createTempDir()
    const skillDir = join(fakeHome, ".claude", "skills", "changelog")
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, "SKILL.md"), "# Changelog skill")

    await runHook({
      transcriptContent: buildTranscript(10),
      binDir,
      extraEnv: { HOME: fakeHome },
    })

    const capturedArgs = await Bun.file(argsFile).text()
    expect(capturedArgs).toContain("/changelog skill")
  })

  test("prompt uses generic changelog fallback when skill is not installed", async () => {
    const binDir = await createTempDir()
    const argsFile = await createArgCapturingAgent(binDir)

    // No skills installed — use an empty fake HOME
    const fakeHome = await createTempDir()

    await runHook({
      transcriptContent: buildTranscript(10),
      binDir,
      extraEnv: { HOME: fakeHome },
    })

    const capturedArgs = await Bun.file(argsFile).text()
    expect(capturedArgs).toContain("update them")
    expect(capturedArgs).not.toContain("/changelog skill")
  })

  test("prompt references /update-memory skill when skill is installed", async () => {
    const binDir = await createTempDir()
    const argsFile = await createArgCapturingAgent(binDir)

    const fakeHome = await createTempDir()
    const skillDir = join(fakeHome, ".claude", "skills", "update-memory")
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, "SKILL.md"), "# Update memory skill")

    await runHook({
      transcriptContent: buildTranscript(10),
      binDir,
      extraEnv: { HOME: fakeHome },
    })

    const capturedArgs = await Bun.file(argsFile).text()
    expect(capturedArgs).toContain("/update-memory skill")
  })

  test("prompt uses generic memory fallback when skill is not installed", async () => {
    const binDir = await createTempDir()
    const argsFile = await createArgCapturingAgent(binDir)

    const fakeHome = await createTempDir()

    await runHook({
      transcriptContent: buildTranscript(10),
      binDir,
      extraEnv: { HOME: fakeHome },
    })

    const capturedArgs = await Bun.file(argsFile).text()
    expect(capturedArgs).toContain("CLAUDE.md or MEMORY.md")
    expect(capturedArgs).not.toContain("/update-memory skill")
  })
})
