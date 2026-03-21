import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { chmod, mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { normalizeTerminateArgs } from "./stop-auto-continue.ts"
import { getSessionTasksDir } from "./utils/hook-utils.ts"
import { useTempDir } from "./utils/test-utils.ts"

// Subprocess-based tests spawn `bun hooks/stop-auto-continue.ts` which is
// slower on CI runners (Ubuntu) than locally. Bump from the default 10s.
setDefaultTimeout(30_000)

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface HookResult {
  decision?: string
  reason?: string
  rawOutput: string
  stderr: string
}

const BUN_EXE = Bun.which("bun") ?? "bun"

const { create: createTempDir } = useTempDir("swiz-auto-continue-")

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

/** Build a minimal structured AgentResponse JSON for GEMINI_TEST_RESPONSE. */
function agentResponse(
  next: string,
  opts: { reflections?: string[]; processCritique?: string; productCritique?: string } = {}
): string {
  return JSON.stringify({
    next,
    reflections: opts.reflections ?? [],
    processCritique: opts.processCritique ?? "",
    productCritique: opts.productCritique ?? "",
  })
}

let sessionCounter = 0

async function runHook({
  transcriptContent,
  stopHookActive = false,
  extraEnv = {},
  cwd,
  sessionId,
}: {
  transcriptContent: string
  stopHookActive?: boolean
  extraEnv?: Record<string, string>
  cwd?: string
  sessionId?: string
}): Promise<HookResult> {
  const workDir = await createTempDir()
  const transcriptPath = join(workDir, "transcript.jsonl")
  await writeFile(transcriptPath, transcriptContent)

  const hookCwd = cwd ?? workDir

  const payload = JSON.stringify({
    transcript_path: transcriptPath,
    stop_hook_active: stopHookActive,
    session_id: sessionId ?? `test-session-${++sessionCounter}`,
    cwd: hookCwd,
  })

  // Isolate HOME so the hook reads autoContinue: true from a temp settings file
  // instead of the real ~/.swiz/settings.json (which may have autoContinue: false).
  const fakeHome = await createTempDir()
  const fakeSwizDir = join(fakeHome, ".swiz")
  await mkdir(fakeSwizDir, { recursive: true })
  await writeFile(join(fakeSwizDir, "settings.json"), JSON.stringify({ autoContinue: true }))

  // Strip CLAUDECODE (would alter agent detection) and GEMINI_API_KEY (tests control it).
  const { CLAUDECODE: _cc, GEMINI_API_KEY: _gk, ...cleanEnv } = process.env
  const proc = Bun.spawn([BUN_EXE, "hooks/stop-auto-continue.ts"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...cleanEnv,
      HOME: fakeHome,
      // Never talk to the real daemon from tests.
      SWIZ_NO_DAEMON: "1",
      // Mock all external AI backends by default so tests never spawn real CLIs.
      // When a mock AI seam is active (AI_TEST_RESPONSE or AI_TEST_CAPTURE_FILE),
      // omit AI_TEST_NO_BACKEND so hasAiProvider() returns true and the seam is used.
      ...("AI_TEST_RESPONSE" in extraEnv ||
      "AI_TEST_CAPTURE_FILE" in extraEnv ||
      "AI_TEST_THROW" in extraEnv
        ? {}
        : { AI_TEST_NO_BACKEND: "1" }),
      ...extraEnv,
    },
  })
  void proc.stdin.write(payload)
  void proc.stdin.end()

  const [rawOutput, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited

  if (!rawOutput.trim()) return { rawOutput, stderr }

  try {
    const parsed = JSON.parse(rawOutput.trim())
    return {
      decision: parsed.decision,
      reason: parsed.reason,
      rawOutput,
      stderr,
    }
  } catch {
    return { rawOutput, stderr }
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("stop-auto-continue", () => {
  test("blocks with AI suggestion for a substantive session", async () => {
    const result = await runHook({
      transcriptContent: buildTranscript(10),
      extraEnv: {
        GEMINI_API_KEY: "test-key",
        AI_TEST_RESPONSE: agentResponse("Commit the changes to main"),
      },
    })

    expect(result.decision).toBe("block")
    expect(result.reason).toContain("Commit the changes to main")
  })

  test("blocks even when stop_hook_active is true (unconditional)", async () => {
    const result = await runHook({
      transcriptContent: buildTranscript(10),
      stopHookActive: true,
      extraEnv: {
        GEMINI_API_KEY: "test-key",
        AI_TEST_RESPONSE: agentResponse("Run the test suite"),
      },
    })

    expect(result.decision).toBe("block")
    expect(result.reason).toContain("Run the test suite")
  })

  test("blocks stop for small sessions (no trivial-session bypass)", async () => {
    const result = await runHook({
      transcriptContent: buildTranscript(3),
    })

    expect(result.decision).toBe("block")
    expect(result.reason).toContain("no AI backend available")
  })

  test("allows stop when auto-continue is disabled in global swiz settings", async () => {
    const homeDir = await createTempDir()
    await mkdir(join(homeDir, ".swiz"), { recursive: true })
    await writeFile(join(homeDir, ".swiz", "settings.json"), '{\n  "autoContinue": false\n}\n')

    const result = await runHook({
      transcriptContent: buildTranscript(10),
      extraEnv: { HOME: homeDir },
    })

    expect(result.decision).toBeUndefined()
    expect(result.stderr).toContain("[stop-auto-continue:AUTO_CONTINUE_DISABLED]")
  })

  test("session override takes precedence over global setting", async () => {
    const homeDir = await createTempDir()
    await mkdir(join(homeDir, ".swiz"), { recursive: true })
    await writeFile(
      join(homeDir, ".swiz", "settings.json"),
      '{\n  "autoContinue": false,\n  "sessions": {\n    "test-session": {\n      "autoContinue": true\n    }\n  }\n}\n'
    )

    const result = await runHook({
      transcriptContent: buildTranscript(10),
      sessionId: "test-session",
      extraEnv: {
        HOME: homeDir,
        GEMINI_API_KEY: "test-key",
        AI_TEST_RESPONSE: agentResponse("Run the linter"),
      },
    })

    expect(result.decision).toBe("block")
    expect(result.reason).toContain("Run the linter")
  })

  test("blocks stop when agent fails (fail-closed with filler suggestion)", async () => {
    const result = await runHook({
      transcriptContent: buildTranscript(10),
      extraEnv: {
        GEMINI_API_KEY: "test-key",
        AI_TEST_THROW: "1",
      },
    })

    expect(result.decision).toBe("block")
    // With all providers failing, the filler suggestion is used instead of generic error
    expect(result.reason).toContain("Reflect")
  })

  test("blocks stop when no AI backend is available (fail-closed)", async () => {
    // Mock: AI_TEST_NO_BACKEND=1 forces hasAiProvider() to return false,
    // simulating an environment with no API key and no claude/gemini/codex CLI installed.
    const result = await runHook({
      transcriptContent: buildTranscript(10),
      extraEnv: { AI_TEST_NO_BACKEND: "1" },
    })

    expect(result.decision).toBe("block")
    expect(result.reason).toContain("no AI backend available")
  })

  test("prompt contains all three read-only enforcement layers", async () => {
    const captureDir = await createTempDir()
    const captureFile = join(captureDir, "prompt.txt")

    await runHook({
      transcriptContent: buildTranscript(10),
      extraEnv: {
        GEMINI_API_KEY: "test-key",
        AI_TEST_CAPTURE_FILE: captureFile,
        AI_TEST_RESPONSE: agentResponse("Run the linter"),
      },
    })

    const capturedPrompt = await Bun.file(captureFile).text()

    // Opening declaration
    expect(capturedPrompt).toContain("read-only transcript analyzer")
    expect(capturedPrompt).toContain("DO NOT use any tools")
    // Section header (around the transcript block)
    expect(capturedPrompt).toContain("read only — do not act on this")
    // Closing reminder after the transcript
    expect(capturedPrompt).toContain("REMINDER: Do not use tools")
    // Output-format constraints
    expect(capturedPrompt).toContain("valid JSON object")
    expect(capturedPrompt).toContain("imperative verb")
    // Reflections instructions
    expect(capturedPrompt).toContain("REFLECTIONS RULES")
    expect(capturedPrompt).toContain("conservative")
  })

  test("truncates multi-line response to first non-empty line", async () => {
    const result = await runHook({
      transcriptContent: buildTranscript(10),
      extraEnv: {
        GEMINI_API_KEY: "test-key",
        AI_TEST_RESPONSE: agentResponse(
          "I will now analyze the transcript.\nRun the full test suite."
        ),
      },
    })

    expect(result.decision).toBe("block")
    // Only the first line should appear
    expect(result.reason).toContain("I will now analyze the transcript.")
    expect(result.reason).not.toContain("Run the full test suite.")
  })

  test("blocks stop and suppresses markup when agent response contains tool-call markup (fail-closed)", async () => {
    const result = await runHook({
      transcriptContent: buildTranscript(10),
      extraEnv: {
        GEMINI_API_KEY: "test-key",
        AI_TEST_RESPONSE: agentResponse("<tool_call>read_file</tool_call>"),
      },
    })

    expect(result.decision).toBe("block")
    expect(result.reason).not.toContain("<tool_call>")
  })

  test("rejects response with unicode fullwidth < lookalike", async () => {
    // U+FF1C FULLWIDTH LESS-THAN SIGN — NFKC-normalises to ASCII <
    const result = await runHook({
      transcriptContent: buildTranscript(10),
      extraEnv: {
        GEMINI_API_KEY: "test-key",
        AI_TEST_RESPONSE: agentResponse("\uFF1Ctool_call\uFF1E"),
      },
    })

    expect(result.decision).toBe("block")
    expect(result.reason).not.toContain("\uFF1Ctool_call")
  })

  test("rejects response with zero-width joiner injected between < and tag name", async () => {
    // U+200D ZWJ between < and tag name would break /<\w/ without stripping
    const result = await runHook({
      transcriptContent: buildTranscript(10),
      extraEnv: {
        GEMINI_API_KEY: "test-key",
        AI_TEST_RESPONSE: agentResponse("<\u200Dtool_call>"),
      },
    })

    expect(result.decision).toBe("block")
    expect(result.reason).not.toContain("<\u200Dtool_call>")
  })

  test("rejects response with RTL override character before markup", async () => {
    // U+202E RIGHT-TO-LEFT OVERRIDE — ASCII < is still present, already caught
    const result = await runHook({
      transcriptContent: buildTranscript(10),
      extraEnv: {
        GEMINI_API_KEY: "test-key",
        AI_TEST_RESPONSE: agentResponse("\u202E<tool_call>"),
      },
    })

    expect(result.decision).toBe("block")
  })

  test("rejects response with CJK left angle bracket homoglyph 〈 (U+3008)", async () => {
    const result = await runHook({
      transcriptContent: buildTranscript(10),
      extraEnv: {
        GEMINI_API_KEY: "test-key",
        AI_TEST_RESPONSE: agentResponse("\u3008tool_call\u3009"),
      },
    })

    expect(result.decision).toBe("block")
    expect(result.reason).not.toContain("\u3008tool_call")
  })

  test("rejects response with single left-pointing angle quotation ‹ (U+2039)", async () => {
    const result = await runHook({
      transcriptContent: buildTranscript(10),
      extraEnv: {
        GEMINI_API_KEY: "test-key",
        AI_TEST_RESPONSE: agentResponse("\u2039tool_call\u203A"),
      },
    })

    expect(result.decision).toBe("block")
    expect(result.reason).not.toContain("\u2039tool_call")
  })

  test("rejects response with mathematical left angle bracket ⟨ (U+27E8)", async () => {
    const result = await runHook({
      transcriptContent: buildTranscript(10),
      extraEnv: {
        GEMINI_API_KEY: "test-key",
        AI_TEST_RESPONSE: agentResponse("\u27E8tool_call\u27E9"),
      },
    })

    expect(result.decision).toBe("block")
    expect(result.reason).not.toContain("\u27E8tool_call")
  })

  test("rejects response with modifier letter left arrowhead ˂ (U+02C2)", async () => {
    const result = await runHook({
      transcriptContent: buildTranscript(10),
      extraEnv: {
        GEMINI_API_KEY: "test-key",
        AI_TEST_RESPONSE: agentResponse("\u02C2tool_call\u02C3"),
      },
    })

    expect(result.decision).toBe("block")
    expect(result.reason).not.toContain("\u02C2tool_call")
  })

  test("rejects response with Canadian Syllabics PA ᐸ (U+1438)", async () => {
    const result = await runHook({
      transcriptContent: buildTranscript(10),
      extraEnv: {
        GEMINI_API_KEY: "test-key",
        AI_TEST_RESPONSE: agentResponse("\u1438tool_call\u1433"),
      },
    })

    expect(result.decision).toBe("block")
    expect(result.reason).not.toContain("\u1438tool_call")
  })

  test("rejects response with heavy left-pointing angle quotation ❮ (U+276E)", async () => {
    const result = await runHook({
      transcriptContent: buildTranscript(10),
      extraEnv: {
        GEMINI_API_KEY: "test-key",
        AI_TEST_RESPONSE: agentResponse("\u276Etool_call\u276F"),
      },
    })

    expect(result.decision).toBe("block")
    expect(result.reason).not.toContain("\u276Etool_call")
  })

  test("rejects response with small less-than sign ﹤ (U+FE64, NFKC→<)", async () => {
    const result = await runHook({
      transcriptContent: buildTranscript(10),
      extraEnv: {
        GEMINI_API_KEY: "test-key",
        AI_TEST_RESPONSE: agentResponse("\uFE64tool_call\uFE65"),
      },
    })

    expect(result.decision).toBe("block")
  })

  test("rejects response with heavy left-pointing angle bracket ❰ (U+2770)", async () => {
    const result = await runHook({
      transcriptContent: buildTranscript(10),
      extraEnv: {
        GEMINI_API_KEY: "test-key",
        AI_TEST_RESPONSE: agentResponse("\u2770tool_call\u2771"),
      },
    })

    expect(result.decision).toBe("block")
  })

  test("rejects response with mathematical left double angle bracket ⟪ (U+27EA)", async () => {
    const result = await runHook({
      transcriptContent: buildTranscript(10),
      extraEnv: {
        GEMINI_API_KEY: "test-key",
        AI_TEST_RESPONSE: agentResponse("\u27EAtool_call\u27EB"),
      },
    })

    expect(result.decision).toBe("block")
  })

  test("rejects response with left angle bracket with dot ⦑ (U+2991)", async () => {
    const result = await runHook({
      transcriptContent: buildTranscript(10),
      extraEnv: {
        GEMINI_API_KEY: "test-key",
        AI_TEST_RESPONSE: agentResponse("\u2991tool_call\u2992"),
      },
    })

    expect(result.decision).toBe("block")
  })

  test("rejects response with left-pointing curved angle bracket ⧼ (U+29FC)", async () => {
    const result = await runHook({
      transcriptContent: buildTranscript(10),
      extraEnv: {
        GEMINI_API_KEY: "test-key",
        AI_TEST_RESPONSE: agentResponse("\u29FCtool_call\u29FD"),
      },
    })

    expect(result.decision).toBe("block")
  })

  test("rejects response with leading-whitespace XML tag", async () => {
    const result = await runHook({
      transcriptContent: buildTranscript(10),
      extraEnv: {
        GEMINI_API_KEY: "test-key",
        AI_TEST_RESPONSE: agentResponse("  <tool_call>read_file</tool_call>"),
      },
    })

    expect(result.decision).toBe("block")
    expect(result.reason).not.toContain("<tool_call>")
  })

  test("rejects response with XML markup embedded after normal text", async () => {
    const result = await runHook({
      transcriptContent: buildTranscript(10),
      extraEnv: {
        GEMINI_API_KEY: "test-key",
        AI_TEST_RESPONSE: agentResponse("Run the tests <tool_call>bash</tool_call>"),
      },
    })

    expect(result.decision).toBe("block")
    expect(result.reason).not.toContain("<tool_call>")
  })

  test("skips empty lines and returns first non-empty clean line", async () => {
    const result = await runHook({
      transcriptContent: buildTranscript(10),
      extraEnv: {
        GEMINI_API_KEY: "test-key",
        AI_TEST_RESPONSE: agentResponse("\n\nRun the full test suite."),
      },
    })

    expect(result.decision).toBe("block")
    expect(result.reason).toContain("Run the full test suite.")
  })

  // ─── Session task context tests ─────────────────────────────────────────────

  /** Creates a fake HOME tree with a tasks dir for "test-session" and returns the home path. */
  async function setupTasksDir(sessionId = "test-session"): Promise<string> {
    const fakeHome = await createTempDir()
    const tasksDir = getSessionTasksDir(sessionId, fakeHome)
    if (!tasksDir) throw new Error("Failed to resolve session tasks directory")
    await mkdir(tasksDir, { recursive: true })
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
    const tasksDir = getSessionTasksDir(sessionId, fakeHome)
    if (!tasksDir) throw new Error("Failed to resolve session tasks directory")
    await writeFile(join(tasksDir, `${id}.json`), JSON.stringify({ id, status, subject }))
  }

  test("omits SESSION TASKS section when tasks directory does not exist", async () => {
    const fakeHome = await createTempDir() // no .claude/tasks created
    const captureDir = await createTempDir()
    const captureFile = join(captureDir, "prompt.txt")

    await runHook({
      transcriptContent: buildTranscript(10),
      sessionId: "test-session",
      extraEnv: {
        HOME: fakeHome,
        GEMINI_API_KEY: "test-key",
        AI_TEST_CAPTURE_FILE: captureFile,
        AI_TEST_RESPONSE: agentResponse("Run the tests"),
      },
    })

    const capturedPrompt = await Bun.file(captureFile).text()
    expect(capturedPrompt).not.toContain("=== SESSION TASKS ===")
  })

  test("omits SESSION TASKS section when tasks directory is empty", async () => {
    const fakeHome = await setupTasksDir()
    const captureDir = await createTempDir()
    const captureFile = join(captureDir, "prompt.txt")

    await runHook({
      transcriptContent: buildTranscript(10),
      sessionId: "test-session",
      extraEnv: {
        HOME: fakeHome,
        GEMINI_API_KEY: "test-key",
        AI_TEST_CAPTURE_FILE: captureFile,
        AI_TEST_RESPONSE: agentResponse("Run the tests"),
      },
    })

    const capturedPrompt = await Bun.file(captureFile).text()
    expect(capturedPrompt).not.toContain("=== SESSION TASKS ===")
  })

  test("includes COMPLETED tasks in SESSION TASKS section", async () => {
    const fakeHome = await setupTasksDir()
    await writeTask(fakeHome, "1", "completed", "Fix the auth bug")
    await writeTask(fakeHome, "2", "completed", "Add unit tests")
    const captureDir = await createTempDir()
    const captureFile = join(captureDir, "prompt.txt")

    await runHook({
      transcriptContent: buildTranscript(10),
      sessionId: "test-session",
      extraEnv: {
        HOME: fakeHome,
        GEMINI_API_KEY: "test-key",
        AI_TEST_CAPTURE_FILE: captureFile,
        AI_TEST_RESPONSE: agentResponse("Run the tests"),
      },
    })

    const capturedPrompt = await Bun.file(captureFile).text()
    expect(capturedPrompt).toContain("SESSION TASKS")
    expect(capturedPrompt).toContain("COMPLETED:")
    expect(capturedPrompt).toContain("Fix the auth bug (#1)")
    expect(capturedPrompt).toContain("Add unit tests (#2)")
  })

  test("includes IN PROGRESS tasks in SESSION TASKS section", async () => {
    const fakeHome = await setupTasksDir()
    await writeTask(fakeHome, "3", "in_progress", "Refactor CLI entry")
    const captureDir = await createTempDir()
    const captureFile = join(captureDir, "prompt.txt")

    await runHook({
      transcriptContent: buildTranscript(10),
      sessionId: "test-session",
      extraEnv: {
        HOME: fakeHome,
        GEMINI_API_KEY: "test-key",
        AI_TEST_CAPTURE_FILE: captureFile,
        AI_TEST_RESPONSE: agentResponse("Run the tests"),
      },
    })

    const capturedPrompt = await Bun.file(captureFile).text()
    expect(capturedPrompt).toContain("SESSION TASKS")
    expect(capturedPrompt).toContain("IN PROGRESS:")
    expect(capturedPrompt).toContain("Refactor CLI entry (#3)")
  })

  test("excludes pending tasks from SESSION TASKS section", async () => {
    const fakeHome = await setupTasksDir()
    await writeTask(fakeHome, "1", "completed", "Done task")
    await writeTask(fakeHome, "2", "pending", "Not started yet")
    const captureDir = await createTempDir()
    const captureFile = join(captureDir, "prompt.txt")

    await runHook({
      transcriptContent: buildTranscript(10),
      sessionId: "test-session",
      extraEnv: {
        HOME: fakeHome,
        GEMINI_API_KEY: "test-key",
        AI_TEST_CAPTURE_FILE: captureFile,
        AI_TEST_RESPONSE: agentResponse("Run the tests"),
      },
    })

    const capturedPrompt = await Bun.file(captureFile).text()
    expect(capturedPrompt).toContain("Done task (#1)")
    expect(capturedPrompt).not.toContain("Not started yet")
  })

  test("shows both IN PROGRESS and COMPLETED in mixed-status session", async () => {
    const fakeHome = await setupTasksDir()
    await writeTask(fakeHome, "1", "completed", "Write tests")
    await writeTask(fakeHome, "2", "in_progress", "Fix type errors")
    await writeTask(fakeHome, "3", "pending", "Deploy to prod")
    const captureDir = await createTempDir()
    const captureFile = join(captureDir, "prompt.txt")

    await runHook({
      transcriptContent: buildTranscript(10),
      sessionId: "test-session",
      extraEnv: {
        HOME: fakeHome,
        GEMINI_API_KEY: "test-key",
        AI_TEST_CAPTURE_FILE: captureFile,
        AI_TEST_RESPONSE: agentResponse("Run the tests"),
      },
    })

    const capturedPrompt = await Bun.file(captureFile).text()
    expect(capturedPrompt).toContain("IN PROGRESS:")
    expect(capturedPrompt).toContain("Fix type errors (#2)")
    expect(capturedPrompt).toContain("COMPLETED:")
    expect(capturedPrompt).toContain("Write tests (#1)")
    expect(capturedPrompt).not.toContain("Deploy to prod")
  })

  test("silently skips malformed JSON task files and shows valid tasks", async () => {
    const fakeHome = await setupTasksDir()
    await writeTask(fakeHome, "1", "completed", "Valid task")
    // Write a malformed JSON file alongside the valid one
    await writeFile(
      join(getSessionTasksDir("test-session", fakeHome)!, "bad.json"),
      "{ this is not valid json }"
    )
    const captureDir = await createTempDir()
    const captureFile = join(captureDir, "prompt.txt")

    await runHook({
      transcriptContent: buildTranscript(10),
      sessionId: "test-session",
      extraEnv: {
        HOME: fakeHome,
        GEMINI_API_KEY: "test-key",
        AI_TEST_CAPTURE_FILE: captureFile,
        AI_TEST_RESPONSE: agentResponse("Run the tests"),
      },
    })

    const capturedPrompt = await Bun.file(captureFile).text()
    expect(capturedPrompt).toContain("Valid task (#1)")
    // Malformed file should not cause an error message or crash
    expect(capturedPrompt).not.toContain("not valid json")
  })

  test("silently skips task file with null id", async () => {
    const fakeHome = await setupTasksDir()
    await writeTask(fakeHome, "1", "completed", "Real task")
    // Task with literal null id (as produced by some serialization paths)
    await writeFile(
      join(getSessionTasksDir("test-session", fakeHome)!, "nullid.json"),
      JSON.stringify({ id: "null", status: "completed", subject: "Ghost task" })
    )
    const captureDir = await createTempDir()
    const captureFile = join(captureDir, "prompt.txt")

    await runHook({
      transcriptContent: buildTranscript(10),
      sessionId: "test-session",
      extraEnv: {
        HOME: fakeHome,
        GEMINI_API_KEY: "test-key",
        AI_TEST_CAPTURE_FILE: captureFile,
        AI_TEST_RESPONSE: agentResponse("Run the tests"),
      },
    })

    const capturedPrompt = await Bun.file(captureFile).text()
    expect(capturedPrompt).toContain("Real task (#1)")
    expect(capturedPrompt).not.toContain("Ghost task")
  })

  test("ignores non-.json files in tasks directory", async () => {
    const fakeHome = await setupTasksDir()
    await writeTask(fakeHome, "1", "completed", "Real task")
    // Audit log and other non-json files should not be read as tasks
    await writeFile(
      join(getSessionTasksDir("test-session", fakeHome)!, ".audit-log.jsonl"),
      JSON.stringify({ action: "create", taskId: "99", subject: "Should be ignored" })
    )
    const captureDir = await createTempDir()
    const captureFile = join(captureDir, "prompt.txt")

    await runHook({
      transcriptContent: buildTranscript(10),
      sessionId: "test-session",
      extraEnv: {
        HOME: fakeHome,
        GEMINI_API_KEY: "test-key",
        AI_TEST_CAPTURE_FILE: captureFile,
        AI_TEST_RESPONSE: agentResponse("Run the tests"),
      },
    })

    const capturedPrompt = await Bun.file(captureFile).text()
    expect(capturedPrompt).toContain("Real task (#1)")
    expect(capturedPrompt).not.toContain("Should be ignored")
  })

  test("blocks stop when backend times out (fail-closed with filler suggestion)", async () => {
    const result = await runHook({
      transcriptContent: buildTranscript(10),
      extraEnv: {
        GEMINI_API_KEY: "test-key",
        AI_TEST_THROW: "1",
      },
    })

    expect(result.decision).toBe("block")
    // With all providers failing, filler suggestion is used
    expect(result.reason).toContain("Reflect")
  })

  // ─── JSON response parsing tests ──────────────────────────────────────────

  test("parses JSON response with next step", async () => {
    const result = await runHook({
      transcriptContent: buildTranscript(10),
      extraEnv: {
        GEMINI_API_KEY: "test-key",
        AI_TEST_RESPONSE: agentResponse("Run the full test suite"),
      },
    })

    expect(result.decision).toBe("block")
    expect(result.reason).toContain("Run the full test suite")
  })

  test("blocks stop and suppresses markup in JSON next field (fail-closed)", async () => {
    const result = await runHook({
      transcriptContent: buildTranscript(10),
      extraEnv: {
        GEMINI_API_KEY: "test-key",
        AI_TEST_RESPONSE: agentResponse("<tool_call>bash</tool_call>"),
      },
    })

    expect(result.decision).toBe("block")
    expect(result.reason).not.toContain("<tool_call>")
  })

  test("replaces workflow implementation prescriptions with a policy finding", async () => {
    const result = await runHook({
      transcriptContent: buildTranscript(10),
      extraEnv: {
        GEMINI_API_KEY: "test-key",
        AI_TEST_RESPONSE: agentResponse(
          "Implement a guard-aware push orchestration module in plugg-platform"
        ),
      },
    })

    expect(result.decision).toBe("block")
    expect(result.reason).toContain("Collaboration/workflow policy finding detected")
    // The original suggestion is included as a diagnostic to distinguish genuine violations
    // from filter false-positives — wrapped in [Filtered suggestion: "..."] for clarity.
    expect(result.reason).toContain(
      '[Filtered suggestion: "Implement a guard-aware push orchestration module in plugg-platform"]'
    )
  })

  test("filters out reflections containing XML markup", async () => {
    const fakeHome = await createTempDir()
    const hookCwd = await createTempDir()
    const projectKey = hookCwd.replace(/\//g, "-")
    const memoryDir = join(fakeHome, ".claude", "projects", projectKey, "memory")
    await mkdir(memoryDir, { recursive: true })
    const memoryFile = join(memoryDir, "MEMORY.md")
    await writeFile(memoryFile, "# Memory\n")

    await runHook({
      transcriptContent: buildTranscript(10),
      cwd: hookCwd,
      extraEnv: {
        HOME: fakeHome,
        GEMINI_API_KEY: "test-key",
        AI_TEST_RESPONSE: agentResponse("Run the tests", {
          reflections: ["DO: Always use bun instead of npm", "<script>alert('xss')</script>"],
        }),
      },
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
    const fakeHome = await createTempDir()
    const hookCwd = await createTempDir()
    const memoryFile = await setupMemoryDir(fakeHome, hookCwd)

    await runHook({
      transcriptContent: buildTranscript(10),
      cwd: hookCwd,
      extraEnv: {
        HOME: fakeHome,
        GEMINI_API_KEY: "test-key",
        AI_TEST_RESPONSE: agentResponse("Run the tests", {
          reflections: ["DO: Always use bun instead of npm", "DON'T: Use grep, prefer rg"],
        }),
      },
    })

    const memory = await Bun.file(memoryFile).text()
    expect(memory).toContain("## Confirmed Patterns")
    expect(memory).toContain("**DO**: Always use bun instead of npm")
    expect(memory).toContain("**DON'T**: Use grep, prefer rg")
  })

  test("deduplicates reflections against existing memory", async () => {
    const fakeHome = await createTempDir()
    const hookCwd = await createTempDir()
    const memoryFile = await setupMemoryDir(
      fakeHome,
      hookCwd,
      "# Memory\n\n## Confirmed Patterns\n\n- **DO**: Always use bun instead of npm\n"
    )

    await runHook({
      transcriptContent: buildTranscript(10),
      cwd: hookCwd,
      extraEnv: {
        HOME: fakeHome,
        GEMINI_API_KEY: "test-key",
        AI_TEST_RESPONSE: agentResponse("Run the tests", {
          reflections: ["DO: Always use bun instead of npm"],
        }),
      },
    })

    const memory = await Bun.file(memoryFile).text()
    // Should appear exactly once (not duplicated)
    const matches = memory.match(/Always use bun instead of npm/g)
    expect(matches).toHaveLength(1)
  })

  test("appends to existing Confirmed Patterns section without duplicate header", async () => {
    const fakeHome = await createTempDir()
    const hookCwd = await createTempDir()
    const memoryFile = await setupMemoryDir(
      fakeHome,
      hookCwd,
      "# Memory\n\n## Confirmed Patterns\n\n- **DO**: Use TypeScript exclusively\n"
    )

    await runHook({
      transcriptContent: buildTranscript(10),
      cwd: hookCwd,
      extraEnv: {
        HOME: fakeHome,
        GEMINI_API_KEY: "test-key",
        AI_TEST_RESPONSE: agentResponse("Run the tests", {
          reflections: ["DO: Prefer Bun.file over fs.readFile"],
        }),
      },
    })

    const memory = await Bun.file(memoryFile).text()
    // Should have exactly one "## Confirmed Patterns" header
    const headers = memory.match(/## Confirmed Patterns/g)
    expect(headers).toHaveLength(1)
    expect(memory).toContain("Prefer Bun.file over fs.readFile")
    expect(memory).toContain("Use TypeScript exclusively")
  })

  test("skips memory writing when no project dir exists", async () => {
    const fakeHome = await createTempDir()
    // No project dir created — hook should not crash

    const result = await runHook({
      transcriptContent: buildTranscript(10),
      cwd: "/nonexistent/project/path",
      extraEnv: {
        HOME: fakeHome,
        GEMINI_API_KEY: "test-key",
        AI_TEST_RESPONSE: agentResponse("Run the tests", {
          reflections: ["DO: Use bun exclusively"],
        }),
      },
    })

    expect(result.decision).toBe("block")
    expect(result.reason).toContain("Run the tests")
  })

  test("skips reflections that are too short", async () => {
    const fakeHome = await createTempDir()
    const hookCwd = await createTempDir()
    const memoryFile = await setupMemoryDir(fakeHome, hookCwd)

    await runHook({
      transcriptContent: buildTranscript(10),
      cwd: hookCwd,
      extraEnv: {
        HOME: fakeHome,
        GEMINI_API_KEY: "test-key",
        AI_TEST_RESPONSE: agentResponse("Run the tests", {
          reflections: ["short", "DO: Always use bun for running TypeScript files"],
        }),
      },
    })

    const memory = await Bun.file(memoryFile).text()
    expect(memory).not.toContain("short")
    expect(memory).toContain("Always use bun for running TypeScript files")
  })

  test("does not write reflections when memory file would exceed 200 lines", async () => {
    const fakeHome = await createTempDir()
    const hookCwd = await createTempDir()
    // Create a memory file that's already at ~199 lines
    const longContent = `# Memory\n${"\n".repeat(198)}`
    const memoryFile = await setupMemoryDir(fakeHome, hookCwd, longContent)

    await runHook({
      transcriptContent: buildTranscript(10),
      cwd: hookCwd,
      extraEnv: {
        HOME: fakeHome,
        GEMINI_API_KEY: "test-key",
        AI_TEST_RESPONSE: agentResponse("Run the tests", {
          reflections: ["DO: This should not be written to memory"],
        }),
      },
    })

    const memory = await Bun.file(memoryFile).text()
    expect(memory).not.toContain("This should not be written")
  })

  test("does not write reflections when agent returns no reflections", async () => {
    const fakeHome = await createTempDir()
    const hookCwd = await createTempDir()
    const memoryFile = await setupMemoryDir(fakeHome, hookCwd)

    await runHook({
      transcriptContent: buildTranscript(10),
      cwd: hookCwd,
      extraEnv: {
        HOME: fakeHome,
        GEMINI_API_KEY: "test-key",
        AI_TEST_RESPONSE: agentResponse("Run the tests", { reflections: [] }),
      },
    })

    const memory = await Bun.file(memoryFile).text()
    expect(memory).toBe("# Memory\n")
  })

  test("formats reflections without prefix as DO directives", async () => {
    const fakeHome = await createTempDir()
    const hookCwd = await createTempDir()
    const memoryFile = await setupMemoryDir(fakeHome, hookCwd)

    await runHook({
      transcriptContent: buildTranscript(10),
      cwd: hookCwd,
      extraEnv: {
        HOME: fakeHome,
        GEMINI_API_KEY: "test-key",
        AI_TEST_RESPONSE: agentResponse("Run the tests", {
          reflections: ["Always use Bun.spawn instead of child_process"],
        }),
      },
    })

    const memory = await Bun.file(memoryFile).text()
    expect(memory).toContain("- **DO**: Always use Bun.spawn instead of child_process")
  })

  // ─── Critique field tests ────────────────────────────────────────────────

  test("includes process and product critiques with labels before the finding line", async () => {
    const result = await runHook({
      transcriptContent: buildTranscript(10),
      extraEnv: {
        GEMINI_API_KEY: "test-key",
        AI_TEST_RESPONSE: agentResponse("Run the full test suite", {
          processCritique: "You skipped reading the existing implementation before modifying it.",
          productCritique: "The fix handles the happy path but leaves the error case broken.",
        }),
      },
    })

    expect(result.decision).toBe("block")
    expect(result.reason).toContain("Process:")
    expect(result.reason).toContain("Product:")
    expect(result.reason).toContain(
      "You skipped reading the existing implementation before modifying it."
    )
    expect(result.reason).toContain(
      "The fix handles the happy path but leaves the error case broken."
    )
    expect(result.reason).toContain("Run the full test suite")
    // Critiques must appear before the finding line
    const critiqueIdx = result.reason!.indexOf("Process:")
    const findingIdx = result.reason!.indexOf("Stop blocked — unresolved finding")
    expect(critiqueIdx).toBeLessThan(findingIdx)
  })

  test("omits critique when JSON response has no critique field", async () => {
    const result = await runHook({
      transcriptContent: buildTranscript(10),
      extraEnv: {
        GEMINI_API_KEY: "test-key",
        AI_TEST_RESPONSE: agentResponse("Run the full test suite"),
      },
    })

    expect(result.decision).toBe("block")
    expect(result.reason).not.toContain("Session critique:")
    expect(result.reason!.trimStart()).toMatch(/^Stop blocked — unresolved finding:/)
    expect(result.reason).toContain("Run the full test suite")
  })

  test("omits critique labels when both critique fields are empty strings", async () => {
    const result = await runHook({
      transcriptContent: buildTranscript(10),
      extraEnv: {
        GEMINI_API_KEY: "test-key",
        AI_TEST_RESPONSE: agentResponse("Run the linter", {
          processCritique: "",
          productCritique: "",
        }),
      },
    })

    expect(result.decision).toBe("block")
    expect(result.reason).not.toContain("Process:")
    expect(result.reason).not.toContain("Product:")
    expect(result.reason!.trimStart()).toMatch(/^Stop blocked — unresolved finding:/)
    expect(result.reason).toContain("Run the linter")
  })

  test("rejects markup in critique fields and omits those critiques", async () => {
    const result = await runHook({
      transcriptContent: buildTranscript(10),
      extraEnv: {
        GEMINI_API_KEY: "test-key",
        AI_TEST_RESPONSE: agentResponse("Run the tests", {
          processCritique: "<tool_call>bash</tool_call>",
          productCritique: "<tool_call>bash</tool_call>",
        }),
      },
    })

    expect(result.decision).toBe("block")
    expect(result.reason).not.toContain("<tool_call>")
    expect(result.reason!.trimStart()).toMatch(/^Stop blocked — unresolved finding:/)
    expect(result.reason).toContain("Run the tests")
  })

  test("truncates multi-line processCritique to first non-empty line", async () => {
    const result = await runHook({
      transcriptContent: buildTranscript(10),
      extraEnv: {
        GEMINI_API_KEY: "test-key",
        AI_TEST_RESPONSE: agentResponse("Fix the root cause of the failure", {
          processCritique: "You retried the same command repeatedly.\nThis was the second line.",
          productCritique: "",
        }),
      },
    })

    expect(result.decision).toBe("block")
    expect(result.reason).toContain("You retried the same command repeatedly.")
    expect(result.reason).not.toContain("This was the second line.")
  })

  test("prompt contains CRITIQUE RULES section with process and product axes", async () => {
    const captureDir = await createTempDir()
    const captureFile = join(captureDir, "prompt.txt")
    const fakeHome = await createTempDir()

    await runHook({
      transcriptContent: buildTranscript(10),
      extraEnv: {
        HOME: fakeHome,
        GEMINI_API_KEY: "test-key",
        AI_TEST_CAPTURE_FILE: captureFile,
        AI_TEST_RESPONSE: agentResponse("Run the linter"),
      },
    })

    const capturedPrompt = await Bun.file(captureFile).text()
    expect(capturedPrompt).toContain("CRITIQUE RULES")
    expect(capturedPrompt).toContain("PROCESS CRITIQUE")
    expect(capturedPrompt).toContain("PRODUCT CRITIQUE")
    expect(capturedPrompt).toContain("HOW the work was executed")
    expect(capturedPrompt).toContain("WHAT was built")
  })

  test("prompt OUTPUT FORMAT includes processCritique and productCritique fields", async () => {
    const captureDir = await createTempDir()
    const captureFile = join(captureDir, "prompt.txt")
    const fakeHome = await createTempDir()

    await runHook({
      transcriptContent: buildTranscript(10),
      extraEnv: {
        HOME: fakeHome,
        GEMINI_API_KEY: "test-key",
        AI_TEST_CAPTURE_FILE: captureFile,
        AI_TEST_RESPONSE: agentResponse("Run the linter"),
      },
    })

    const capturedPrompt = await Bun.file(captureFile).text()
    expect(capturedPrompt).toContain('"processCritique"')
    expect(capturedPrompt).toContain('"productCritique"')
  })

  test("creative ambition mode injects roadmap issue-drafting instructions", async () => {
    const captureDir = await createTempDir()
    const captureFile = join(captureDir, "prompt.txt")
    const fakeHome = await createTempDir()
    await mkdir(join(fakeHome, ".swiz"), { recursive: true })
    await writeFile(
      join(fakeHome, ".swiz", "settings.json"),
      JSON.stringify({ autoContinue: true, ambitionMode: "creative" })
    )

    await runHook({
      transcriptContent: buildTranscript(10),
      extraEnv: {
        HOME: fakeHome,
        GEMINI_API_KEY: "test-key",
        AI_TEST_CAPTURE_FILE: captureFile,
        AI_TEST_RESPONSE: agentResponse("Create issue: Add personalized onboarding checklist"),
      },
    })

    const capturedPrompt = await Bun.file(captureFile).text()
    expect(capturedPrompt).toContain("CREATIVE MODE")
    expect(capturedPrompt).toContain("product-roadmap drafting")
    expect(capturedPrompt).toContain("user-facing functionality gap")
    expect(capturedPrompt).toContain('starting with "Create issue:"')
    expect(capturedPrompt).not.toContain("AGGRESSIVE MODE")
  })

  test("creative ambition mode normalizes next step into an actionable issue description", async () => {
    const fakeHome = await createTempDir()
    await mkdir(join(fakeHome, ".swiz"), { recursive: true })
    await writeFile(
      join(fakeHome, ".swiz", "settings.json"),
      JSON.stringify({ autoContinue: true, ambitionMode: "creative" })
    )

    const result = await runHook({
      transcriptContent: buildTranscript(10),
      extraEnv: {
        HOME: fakeHome,
        GEMINI_API_KEY: "test-key",
        AI_TEST_RESPONSE: agentResponse("Add onboarding checklist wizard"),
      },
    })

    expect(result.decision).toBe("block")
    expect(result.reason).toContain("Create issue: Add onboarding checklist wizard")
    expect(result.reason).toContain("user-facing gap:")
    expect(result.reason).toContain("scope:")
    expect(result.reason).toContain("acceptance:")
  })

  test("reflective ambition mode injects reflection-driven instructions", async () => {
    const captureDir = await createTempDir()
    const captureFile = join(captureDir, "prompt.txt")
    const fakeHome = await createTempDir()
    await mkdir(join(fakeHome, ".swiz"), { recursive: true })
    await writeFile(
      join(fakeHome, ".swiz", "settings.json"),
      JSON.stringify({ autoContinue: true, ambitionMode: "reflective" })
    )

    await runHook({
      transcriptContent: buildTranscript(10),
      extraEnv: {
        HOME: fakeHome,
        GEMINI_API_KEY: "test-key",
        AI_TEST_CAPTURE_FILE: captureFile,
        AI_TEST_RESPONSE: agentResponse("Implement the next endpoint", {
          reflections: ["DO: Reproduce the bug before applying a fix"],
        }),
      },
    })

    const capturedPrompt = await Bun.file(captureFile).text()
    expect(capturedPrompt).toContain("REFLECTIVE MODE")
    expect(capturedPrompt).toContain(`derive "next" from them`)
    expect(capturedPrompt).not.toContain("CREATIVE MODE")
    expect(capturedPrompt).not.toContain("AGGRESSIVE MODE")
  })

  test("reflective ambition mode derives next step from reflections output", async () => {
    const fakeHome = await createTempDir()
    await mkdir(join(fakeHome, ".swiz"), { recursive: true })
    await writeFile(
      join(fakeHome, ".swiz", "settings.json"),
      JSON.stringify({ autoContinue: true, ambitionMode: "reflective" })
    )

    const result = await runHook({
      transcriptContent: buildTranscript(10),
      extraEnv: {
        HOME: fakeHome,
        GEMINI_API_KEY: "test-key",
        AI_TEST_RESPONSE: agentResponse("Implement placeholder next step", {
          reflections: ["DO: Reproduce the failing behavior before editing source files"],
        }),
      },
    })

    expect(result.decision).toBe("block")
    expect(result.reason).toContain("Apply this confirmed reflection immediately in code:")
    expect(result.reason).toContain("Reproduce the failing behavior before editing source files")
    expect(result.reason).not.toContain("Implement placeholder next step")
  })

  test("project-level ambitionMode=creative drives creative prompt branch", async () => {
    const captureDir = await createTempDir()
    const captureFile = join(captureDir, "prompt.txt")
    const fakeHome = await createTempDir()
    const projectDir = await createTempDir()
    await mkdir(join(fakeHome, ".swiz"), { recursive: true })
    await writeFile(
      join(fakeHome, ".swiz", "settings.json"),
      JSON.stringify({ autoContinue: true })
    )
    await mkdir(join(projectDir, ".swiz"), { recursive: true })
    await writeFile(
      join(projectDir, ".swiz", "config.json"),
      JSON.stringify({ ambitionMode: "creative" })
    )

    await runHook({
      transcriptContent: buildTranscript(10),
      cwd: projectDir,
      extraEnv: {
        HOME: fakeHome,
        GEMINI_API_KEY: "test-key",
        AI_TEST_CAPTURE_FILE: captureFile,
        AI_TEST_RESPONSE: agentResponse("Create issue: Add onboarding checklist"),
      },
    })

    const capturedPrompt = await Bun.file(captureFile).text()
    expect(capturedPrompt).toContain("CREATIVE MODE")
  })

  test("session-level ambitionMode overrides project-level ambitionMode", async () => {
    const captureDir = await createTempDir()
    const captureFile = join(captureDir, "prompt.txt")
    const fakeHome = await createTempDir()
    const projectDir = await createTempDir()
    await mkdir(join(fakeHome, ".swiz"), { recursive: true })
    await writeFile(
      join(fakeHome, ".swiz", "settings.json"),
      JSON.stringify({
        autoContinue: true,
        ambitionMode: "standard",
        sessions: { "test-session": { autoContinue: true, ambitionMode: "creative" } },
      })
    )
    await mkdir(join(projectDir, ".swiz"), { recursive: true })
    await writeFile(
      join(projectDir, ".swiz", "config.json"),
      JSON.stringify({ ambitionMode: "aggressive" })
    )

    await runHook({
      transcriptContent: buildTranscript(10),
      cwd: projectDir,
      sessionId: "test-session",
      extraEnv: {
        HOME: fakeHome,
        GEMINI_API_KEY: "test-key",
        AI_TEST_CAPTURE_FILE: captureFile,
        AI_TEST_RESPONSE: agentResponse("Create issue: Add onboarding checklist"),
      },
    })

    const capturedPrompt = await Bun.file(captureFile).text()
    expect(capturedPrompt).toContain("CREATIVE MODE")
    expect(capturedPrompt).not.toContain("AGGRESSIVE MODE")
  })

  // ─── skillAdvice prompt guard tests ──────────────────────────────────────

  test("prompt references /changelog skill when skill is installed", async () => {
    const captureDir = await createTempDir()
    const captureFile = join(captureDir, "prompt.txt")

    // Create a fake skill directory so skillExists("changelog") returns true
    const fakeHome = await createTempDir()
    const skillDir = join(fakeHome, ".claude", "skills", "changelog")
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, "SKILL.md"), "# Changelog skill")

    await runHook({
      transcriptContent: buildTranscript(10),
      extraEnv: {
        HOME: fakeHome,
        GEMINI_API_KEY: "test-key",
        AI_TEST_CAPTURE_FILE: captureFile,
        AI_TEST_RESPONSE: agentResponse("Run the linter"),
      },
    })

    const capturedPrompt = await Bun.file(captureFile).text()
    expect(capturedPrompt).toContain("/changelog skill")
  })

  test("prompt uses generic changelog fallback when skill is not installed", async () => {
    const captureDir = await createTempDir()
    const captureFile = join(captureDir, "prompt.txt")

    // No skills installed — use an empty fake HOME
    const fakeHome = await createTempDir()

    await runHook({
      transcriptContent: buildTranscript(10),
      extraEnv: {
        HOME: fakeHome,
        GEMINI_API_KEY: "test-key",
        AI_TEST_CAPTURE_FILE: captureFile,
        AI_TEST_RESPONSE: agentResponse("Run the linter"),
      },
    })

    const capturedPrompt = await Bun.file(captureFile).text()
    expect(capturedPrompt).toContain("update them")
    expect(capturedPrompt).not.toContain("/changelog skill")
  })

  test("prompt references /update-memory skill when skill is installed", async () => {
    const captureDir = await createTempDir()
    const captureFile = join(captureDir, "prompt.txt")

    const fakeHome = await createTempDir()
    const skillDir = join(fakeHome, ".claude", "skills", "update-memory")
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, "SKILL.md"), "# Update memory skill")

    await runHook({
      transcriptContent: buildTranscript(10),
      extraEnv: {
        HOME: fakeHome,
        GEMINI_API_KEY: "test-key",
        AI_TEST_CAPTURE_FILE: captureFile,
        AI_TEST_RESPONSE: agentResponse("Run the linter"),
      },
    })

    const capturedPrompt = await Bun.file(captureFile).text()
    expect(capturedPrompt).toContain("/update-memory skill")
    expect(capturedPrompt).toContain("Cause to capture: <specific cause>")
    expect(capturedPrompt).toContain("ignored instruction, blocked workflow gap, or failure mode")
  })

  test("prompt uses generic memory fallback when skill is not installed", async () => {
    const captureDir = await createTempDir()
    const captureFile = join(captureDir, "prompt.txt")

    const fakeHome = await createTempDir()

    await runHook({
      transcriptContent: buildTranscript(10),
      extraEnv: {
        HOME: fakeHome,
        GEMINI_API_KEY: "test-key",
        AI_TEST_CAPTURE_FILE: captureFile,
        AI_TEST_RESPONSE: agentResponse("Run the linter"),
      },
    })

    const capturedPrompt = await Bun.file(captureFile).text()
    expect(capturedPrompt).toContain("CLAUDE.md or MEMORY.md")
    expect(capturedPrompt).not.toContain("/update-memory skill")
    expect(capturedPrompt).toContain("Cause to capture: <specific cause>")
  })

  test("prompt references /refine-issue skill in priority order when skill is installed", async () => {
    const captureDir = await createTempDir()
    const captureFile = join(captureDir, "prompt.txt")

    const fakeHome = await createTempDir()
    const skillDir = join(fakeHome, ".claude", "skills", "refine-issue")
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, "SKILL.md"), "# Refine issue skill")

    await runHook({
      transcriptContent: buildTranscript(10),
      extraEnv: {
        HOME: fakeHome,
        GEMINI_API_KEY: "test-key",
        AI_TEST_CAPTURE_FILE: captureFile,
        AI_TEST_RESPONSE: agentResponse("Run the linter"),
      },
    })

    const capturedPrompt = await Bun.file(captureFile).text()
    expect(capturedPrompt).toContain("/refine-issue skill")
    expect(capturedPrompt).toContain("issues needing refinement")
  })

  test("prompt uses generic refinement fallback when refine-issue skill is not installed", async () => {
    const captureDir = await createTempDir()
    const captureFile = join(captureDir, "prompt.txt")

    const fakeHome = await createTempDir()

    await runHook({
      transcriptContent: buildTranscript(10),
      extraEnv: {
        HOME: fakeHome,
        GEMINI_API_KEY: "test-key",
        AI_TEST_CAPTURE_FILE: captureFile,
        AI_TEST_RESPONSE: agentResponse("Run the linter"),
      },
    })

    const capturedPrompt = await Bun.file(captureFile).text()
    expect(capturedPrompt).toContain("type, readiness, priority")
    expect(capturedPrompt).not.toContain("/refine-issue skill")
  })

  // ─── Runtime refinement gate tests ───────────────────────────────────────────

  /**
   * Creates a fake git repo at `dir` with a GitHub-style remote.
   * Uses Bun.spawn to avoid execSync security hook.
   */
  async function initFakeGitRepo(dir: string, remoteUrl: string): Promise<void> {
    const run = async (args: string[]) => {
      const proc = Bun.spawn(args, { cwd: dir, stdout: "pipe", stderr: "pipe" })
      await new Response(proc.stdout).text()
      await proc.exited
    }
    await run(["git", "init"])
    await run(["git", "remote", "add", "origin", remoteUrl])
  }

  /**
   * Creates a fake `gh` bun script that serves fixture responses from env vars.
   * Env vars: GH_MOCK_USER, GH_MOCK_ISSUES, GH_MOCK_PRS.
   * Bun.spawn/Bun.which ignore process.env.PATH, so the fake must be
   * prepended to the *full* parent PATH to be resolved first.
   */
  async function createFakeGh(binDir: string): Promise<void> {
    const ghScript =
      `#!/usr/bin/env bun\n` +
      `const args = process.argv.slice(2).join(" ")\n` +
      `if (args.includes("api") && args.includes("user")) {\n` +
      `  process.stdout.write(process.env.GH_MOCK_USER ?? "testuser")\n` +
      `} else if (args.includes("issue") && args.includes("list")) {\n` +
      `  process.stdout.write(process.env.GH_MOCK_ISSUES ?? "[]")\n` +
      `} else if (args.includes("pr") && args.includes("list")) {\n` +
      `  process.stdout.write(process.env.GH_MOCK_PRS ?? "[]")\n` +
      `}\n` +
      `process.exit(0)\n`
    await writeFile(join(binDir, "gh"), ghScript)
    await chmod(join(binDir, "gh"), 0o755)
  }

  test("appends refinement directive when issues need refinement", async () => {
    const repoDir = await createTempDir()
    await initFakeGitRepo(repoDir, "https://github.com/testuser/testrepo.git")

    const binDir = await createTempDir()
    await createFakeGh(binDir)

    // Issue #99 has no readiness labels → needsRefinement returns true
    const issues = JSON.stringify([
      {
        number: 99,
        title: "Unrefined issue",
        labels: [{ name: "bug" }],
        author: { login: "testuser" },
        assignees: [],
      },
    ])

    // Prepend binDir to full PATH so Bun.spawn finds fake gh first
    const result = await runHook({
      transcriptContent: buildTranscript(10),
      cwd: repoDir,
      extraEnv: {
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        GH_MOCK_USER: "testuser",
        GH_MOCK_ISSUES: issues,
        GH_MOCK_PRS: "[]",
        GEMINI_API_KEY: "test-key",
        AI_TEST_RESPONSE: agentResponse("Implement the next feature"),
      },
    })

    expect(result.decision).toBe("block")
    expect(result.reason).toContain("Note:")
    expect(result.reason).toContain("need refinement")
    expect(result.reason).toContain("#99")
  })

  test("omits refinement directive when all issues are refined", async () => {
    const repoDir = await createTempDir()
    await initFakeGitRepo(repoDir, "https://github.com/testuser/testrepo.git")

    const binDir = await createTempDir()
    await createFakeGh(binDir)

    // Issue #50 has type + readiness + priority labels → needsRefinement returns false
    const issues = JSON.stringify([
      {
        number: 50,
        title: "Ready issue",
        labels: [{ name: "bug" }, { name: "ready" }, { name: "priority-high" }],
        author: { login: "testuser" },
        assignees: [],
      },
    ])

    const result = await runHook({
      transcriptContent: buildTranscript(10),
      cwd: repoDir,
      extraEnv: {
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        GH_MOCK_USER: "testuser",
        GH_MOCK_ISSUES: issues,
        GH_MOCK_PRS: "[]",
        GEMINI_API_KEY: "test-key",
        AI_TEST_RESPONSE: agentResponse("Implement the next feature"),
      },
    })

    expect(result.decision).toBe("block")
    expect(result.reason).not.toContain("Note:")
    expect(result.reason).not.toContain("need refinement")
  })

  test("omits refinement directive when no issues exist", async () => {
    const repoDir = await createTempDir()
    await initFakeGitRepo(repoDir, "https://github.com/testuser/testrepo.git")

    const binDir = await createTempDir()
    await createFakeGh(binDir)

    const result = await runHook({
      transcriptContent: buildTranscript(10),
      cwd: repoDir,
      extraEnv: {
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        GH_MOCK_USER: "testuser",
        GH_MOCK_ISSUES: "[]",
        GH_MOCK_PRS: "[]",
        GEMINI_API_KEY: "test-key",
        AI_TEST_RESPONSE: agentResponse("Implement the next feature"),
      },
    })

    expect(result.decision).toBe("block")
    expect(result.reason).not.toContain("Note:")
    expect(result.reason).not.toContain("need refinement")
  })
})

// ─── Workflow suggestion filter unit tests ─────────────────────────────────

import { isWorkflowSuggestion } from "./stop-auto-continue.ts"

describe("isWorkflowSuggestion", () => {
  describe("blocks workflow/git-process suggestions", () => {
    const blocked = [
      "Implement a guard-aware push orchestration module in plugg-platform",
      "Implement a hard-fail in the push skill that blocks any direct main push",
      "Implement bot-aware collaboration detection in the push skill by excluding bot-authored PRs",
      "Implement hook-bot suggestion filtering so outputs exclude workflow/git-process guidance",
      "Add a pre-push hook that validates branch naming conventions",
      "Fix the stop hook to detect stale sessions",
      "Implement a collaboration guard that blocks git push to main",
      "Update the commit skill to enforce conventional commits",
      "Wire up a pre-commit hook for lint-staged checks",
      "Add feature branch enforcement to the push guard",
      "Implement branch policy that requires pull requests for main",
      "Modify the collaboration signal detection to exclude bots",
    ]

    for (const suggestion of blocked) {
      test(`blocks: "${suggestion.slice(0, 60)}..."`, () => {
        expect(isWorkflowSuggestion(suggestion)).toBe(true)
      })
    }
  })

  describe("allows product/code-focused suggestions", () => {
    const allowed = [
      "Implement user profile endpoint with avatar upload support",
      "Add error handling for network timeout in the API client",
      "Fix the date parser to handle ISO 8601 timezone offsets",
      "Build a caching layer for frequently accessed database queries",
      "Extend the search API to support fuzzy matching",
      "Add pagination to the list endpoints",
      "Implement webhook delivery retry with exponential backoff",
      "Fix the login flow to handle expired refresh tokens",
      // Product-level suggestions about the swiz hook framework itself (issue #177 false-positives)
      "Implement session-aware transcript scanning in the hook system",
      "Implement session-aware parsing in the hook framework",
      "Add hook-aware context injection to the session start flow",
      "Fix session boundary detection in the hook infrastructure",
      "Update the hook system to use readSessionLines for cross-session awareness",
    ]

    for (const suggestion of allowed) {
      test(`allows: "${suggestion.slice(0, 60)}..."`, () => {
        expect(isWorkflowSuggestion(suggestion)).toBe(false)
      })
    }
  })

  describe("still blocks specific hook-file implementation directives", () => {
    const blocked = [
      "Implement the pretooluse-repeated-lint-test hook to track consecutive runs",
      "Fix posttooluse-task-output.ts hook to strip ANSI before pattern matching",
      "Update stop-auto-continue.ts hook to use session-scoped transcript scanning",
      "Add a pretooluse-foo hook that validates branch naming conventions",
    ]

    for (const suggestion of blocked) {
      test(`blocks: "${suggestion.slice(0, 60)}..."`, () => {
        expect(isWorkflowSuggestion(suggestion)).toBe(true)
      })
    }
  })
})

// ─── normalizeTerminateArgs unit tests ────────────────────────────────────────

describe("normalizeTerminateArgs", () => {
  test("skip with valid code and message passes through unchanged", () => {
    const { safeAction, normalizedArgs } = normalizeTerminateArgs("skip", ["MY_CODE", "my message"])
    expect(safeAction).toBe("skip")
    expect(normalizedArgs[0]).toBe("MY_CODE")
    expect(normalizedArgs[1]).toBe("my message")
  })

  test("block with valid reason passes through unchanged", () => {
    const { safeAction, normalizedArgs } = normalizeTerminateArgs("block", ["Stop for reason X"])
    expect(safeAction).toBe("block")
    expect(normalizedArgs[0]).toBe("Stop for reason X")
  })

  test("unknown action defaults to block (safe fallback)", () => {
    const { safeAction } = normalizeTerminateArgs("unknown-action", ["some reason"])
    expect(safeAction).toBe("block")
  })

  test("empty action string defaults to block", () => {
    const { safeAction } = normalizeTerminateArgs("", [])
    expect(safeAction).toBe("block")
  })

  test("skip with empty code normalizes to UNKNOWN", () => {
    const { normalizedArgs } = normalizeTerminateArgs("skip", ["", "msg"])
    expect(normalizedArgs[0]).toBe("UNKNOWN")
  })

  test("skip with whitespace-only code normalizes to UNKNOWN", () => {
    const { normalizedArgs } = normalizeTerminateArgs("skip", ["   ", "msg"])
    expect(normalizedArgs[0]).toBe("UNKNOWN")
  })

  test("skip with empty message normalizes to fallback text", () => {
    const { normalizedArgs } = normalizeTerminateArgs("skip", ["CODE", ""])
    expect(normalizedArgs[1]).toBe("unspecified exit reason")
  })

  test("skip with no args normalizes both code and message", () => {
    const { safeAction, normalizedArgs } = normalizeTerminateArgs("skip", [])
    expect(safeAction).toBe("skip")
    expect(normalizedArgs[0]).toBe("UNKNOWN")
    expect(normalizedArgs[1]).toBe("unspecified exit reason")
  })

  test("block with empty reason normalizes to malformed-payload fallback", () => {
    const { normalizedArgs } = normalizeTerminateArgs("block", [""])
    expect(normalizedArgs[0]).toContain("unexpected termination")
  })

  test("block with whitespace-only reason normalizes to malformed-payload fallback", () => {
    const { normalizedArgs } = normalizeTerminateArgs("block", ["   "])
    expect(normalizedArgs[0]).toContain("unexpected termination")
  })

  test("block with no args normalizes to malformed-payload fallback", () => {
    const { normalizedArgs } = normalizeTerminateArgs("block", [])
    expect(normalizedArgs[0]).toContain("unexpected termination")
  })

  test("unknown action with non-empty payload produces block with that payload", () => {
    const { safeAction, normalizedArgs } = normalizeTerminateArgs("invalid", ["some reason"])
    expect(safeAction).toBe("block")
    expect(normalizedArgs[0]).toBe("some reason")
  })
})
