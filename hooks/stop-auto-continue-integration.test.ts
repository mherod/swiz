import { describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { projectKeyFromCwd } from "../src/transcript-utils.ts"
import { getSessionTasksDir } from "../src/utils/hook-utils.ts"
import { useTempDir } from "../src/utils/test-utils.ts"

// ─── Constants ────────────────────────────────────────────────────────────────

const HOOK_PATH = resolve(process.cwd(), "hooks/stop-auto-continue.ts")
const BUN_EXE = Bun.which("bun") ?? "bun"

// ─── Temp dir cleanup ─────────────────────────────────────────────────────────

const { create: createTempDir } = useTempDir("swiz-auto-continue-integ-")

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Seed a fake HOME with ~/.swiz/settings.json containing autoContinue: true.
 * This isolates tests from the real user settings so the hook doesn't exit
 * early when the real setting is false.
 */
async function seedSettings(fakeHome: string): Promise<void> {
  const dir = join(fakeHome, ".swiz")
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, "settings.json"), JSON.stringify({ autoContinue: true }))
}

/** Minimal JSONL transcript with the given number of tool-use turns. */
function buildTranscript(toolCallCount: number): string {
  const lines: string[] = [JSON.stringify({ type: "user", message: { content: "What next?" } })]
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
function agentResponse(next: string): string {
  return JSON.stringify({
    next,
    reflections: [],
    processCritique: "",
    productCritique: "",
  })
}

interface RunResult {
  decision?: string
  reason?: string
  rawOutput: string
}

/** Run the hook with a raw JSON payload (caller controls every field). */
async function runHookRaw(
  payload: Record<string, unknown>,
  extraEnv: Record<string, string> = {}
): Promise<RunResult> {
  // Ensure an isolated HOME with autoContinue:true so the hook doesn't
  // short-circuit based on the developer's real ~/.swiz/settings.json.
  let home = extraEnv.HOME
  if (!home) {
    home = await createTempDir()
    await seedSettings(home)
  }
  // Strip CLAUDECODE (agent detection) and GEMINI_API_KEY (tests control it).
  const { CLAUDECODE: _cc, GEMINI_API_KEY: _gk, ...cleanEnv } = process.env
  const proc = Bun.spawn([BUN_EXE, HOOK_PATH], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...cleanEnv,
      HOME: home,
      ...extraEnv,
    },
  })
  void proc.stdin.write(JSON.stringify(payload))
  void proc.stdin.end()

  const rawOutput = await new Response(proc.stdout).text()
  await proc.exited

  if (!rawOutput.trim()) return { rawOutput }
  try {
    const parsed = JSON.parse(rawOutput.trim())
    return { decision: parsed.decision, reason: parsed.reason, rawOutput }
  } catch {
    return { rawOutput }
  }
}

// ─── Input validation ─────────────────────────────────────────────────────────

describe("stop-auto-continue: input validation", () => {
  test("when transcript_path is missing, falls back and emits manual prompt if no transcript is found", async () => {
    const workDir = await createTempDir()
    // No transcript_path key at all
    const result = await runHookRaw({ session_id: "test", cwd: workDir })

    expect(result.decision).toBe("block")
    expect(result.reason).toContain("Continue directly using the internal-agent prompt below")
    expect(result.reason).toContain("Transcript unavailable.")
  })

  test("blocks when transcript_path is null", async () => {
    const result = await runHookRaw({
      transcript_path: null,
      session_id: "test",
      cwd: "/tmp",
    })

    expect(result.decision).toBe("block")
    expect(result.reason).toContain("malformed stop-hook input")
  })

  test("falls back when transcript file does not exist on disk, then emits manual prompt if no fallback transcript", async () => {
    const workDir = await createTempDir()
    const result = await runHookRaw({
      transcript_path: "/nonexistent/path/transcript.jsonl",
      session_id: "test",
      cwd: workDir,
    })

    expect(result.decision).toBe("block")
    expect(result.reason).toContain("Continue directly using the internal-agent prompt below")
  })

  test("uses cwd transcript fallback when transcript_path is missing", async () => {
    const fakeHome = await createTempDir()
    await seedSettings(fakeHome)
    const workDir = await createTempDir()
    const projectKey = projectKeyFromCwd(workDir)
    const claudeProjectDir = join(fakeHome, ".claude", "projects", projectKey)
    await mkdir(claudeProjectDir, { recursive: true })
    await writeFile(join(claudeProjectDir, "fallback-session.jsonl"), buildTranscript(2))

    const result = await runHookRaw(
      {
        // no transcript_path -> should discover transcript from cwd
        session_id: "test",
        cwd: workDir,
      },
      { HOME: fakeHome, AI_TEST_NO_BACKEND: "1" }
    )

    expect(result.decision).toBe("block")
    expect(result.reason).toContain("no AI backend available")
    expect(result.reason).not.toContain("Continue directly using the internal-agent prompt below")
  })

  test("blocks when transcript contains no tool calls (all text turns)", async () => {
    const workDir = await createTempDir()

    // Transcript with only user+assistant text turns, no tool_use blocks
    const transcript =
      JSON.stringify({ type: "user", message: { content: "Hello" } }) +
      "\n" +
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "Hi there!" }] },
      }) +
      "\n"
    const transcriptPath = join(workDir, "transcript.jsonl")
    await writeFile(transcriptPath, transcript)

    const result = await runHookRaw(
      {
        transcript_path: transcriptPath,
        session_id: "test",
        cwd: workDir,
      },
      { AI_TEST_NO_BACKEND: "1" }
    )

    expect(result.decision).toBe("block")
    expect(result.reason).toContain("no AI backend available")
  })
})

// ─── Small-session behavior ───────────────────────────────────────────────────

describe("stop-auto-continue: small-session behavior", () => {
  test("4 tool calls still blocks (no threshold bypass)", async () => {
    const workDir = await createTempDir()
    const transcriptPath = join(workDir, "transcript.jsonl")
    await writeFile(transcriptPath, buildTranscript(4))

    const result = await runHookRaw(
      {
        transcript_path: transcriptPath,
        session_id: "test",
        cwd: workDir,
      },
      { AI_TEST_NO_BACKEND: "1" }
    )

    expect(result.decision).toBe("block")
    expect(result.reason).toContain("no AI backend available")
  })

  test("5 tool calls blocks", async () => {
    const workDir = await createTempDir()
    const transcriptPath = join(workDir, "transcript.jsonl")
    await writeFile(transcriptPath, buildTranscript(5))

    const result = await runHookRaw(
      {
        transcript_path: transcriptPath,
        session_id: "test",
        cwd: workDir,
      },
      {
        GEMINI_API_KEY: "test-key",
        GEMINI_TEST_RESPONSE: agentResponse("Fix the failing test"),
      }
    )

    expect(result.decision).toBe("block")
    expect(result.reason).toContain("Fix the failing test")
  })
})

// ─── Prompt structure ordering ────────────────────────────────────────────────

describe("stop-auto-continue: prompt ordering with session tasks", () => {
  /** Writes a task JSON file into a fake HOME's tasks dir. */
  async function writeTask(
    fakeHome: string,
    id: string,
    status: string,
    subject: string,
    sessionId = "test-session"
  ): Promise<void> {
    const tasksDir = getSessionTasksDir(sessionId, fakeHome)
    if (!tasksDir) throw new Error("Failed to resolve session tasks directory")
    await mkdir(tasksDir, { recursive: true })
    await writeFile(join(tasksDir, `${id}.json`), JSON.stringify({ id, status, subject }))
  }

  test("SESSION TASKS block appears before CONVERSATION TRANSCRIPT in the prompt", async () => {
    const fakeHome = await createTempDir()
    await seedSettings(fakeHome)
    await writeTask(fakeHome, "1", "completed", "Write tests")
    await writeTask(fakeHome, "2", "in_progress", "Fix types")

    const captureDir = await createTempDir()
    const captureFile = join(captureDir, "prompt.txt")
    const workDir = await createTempDir()
    const transcriptPath = join(workDir, "transcript.jsonl")
    await writeFile(transcriptPath, buildTranscript(10))

    await runHookRaw(
      { transcript_path: transcriptPath, session_id: "test-session", cwd: workDir },
      {
        HOME: fakeHome,
        GEMINI_API_KEY: "test-key",
        GEMINI_TEST_CAPTURE_FILE: captureFile,
        GEMINI_TEST_RESPONSE: agentResponse("Run the linter"),
      }
    )

    const capturedPrompt = await Bun.file(captureFile).text()
    const tasksIdx = capturedPrompt.indexOf("SESSION TASKS")
    const transcriptIdx = capturedPrompt.indexOf("CONVERSATION TRANSCRIPT")
    expect(tasksIdx).toBeGreaterThan(-1)
    expect(transcriptIdx).toBeGreaterThan(-1)
    expect(tasksIdx).toBeLessThan(transcriptIdx)
  })

  test("COMPLETED tasks appear before IN PROGRESS tasks in the prompt", async () => {
    const fakeHome = await createTempDir()
    await seedSettings(fakeHome)
    await writeTask(fakeHome, "1", "completed", "Done thing")
    await writeTask(fakeHome, "2", "in_progress", "Active thing")

    const captureDir = await createTempDir()
    const captureFile = join(captureDir, "prompt.txt")
    const workDir = await createTempDir()
    const transcriptPath = join(workDir, "transcript.jsonl")
    await writeFile(transcriptPath, buildTranscript(10))

    await runHookRaw(
      { transcript_path: transcriptPath, session_id: "test-session", cwd: workDir },
      {
        HOME: fakeHome,
        GEMINI_API_KEY: "test-key",
        GEMINI_TEST_CAPTURE_FILE: captureFile,
        GEMINI_TEST_RESPONSE: agentResponse("Run the linter"),
      }
    )

    const capturedPrompt = await Bun.file(captureFile).text()
    const inProgressIdx = capturedPrompt.indexOf("IN PROGRESS:")
    const completedIdx = capturedPrompt.indexOf("COMPLETED:")
    expect(completedIdx).toBeGreaterThan(-1)
    expect(inProgressIdx).toBeGreaterThan(-1)
    expect(completedIdx).toBeLessThan(inProgressIdx)
  })

  test("empty session_id produces no SESSION TASKS block but still blocks", async () => {
    const captureDir = await createTempDir()
    const captureFile = join(captureDir, "prompt.txt")
    const workDir = await createTempDir()
    const transcriptPath = join(workDir, "transcript.jsonl")
    await writeFile(transcriptPath, buildTranscript(10))

    const result = await runHookRaw(
      { transcript_path: transcriptPath, session_id: "", cwd: workDir },
      {
        GEMINI_API_KEY: "test-key",
        GEMINI_TEST_CAPTURE_FILE: captureFile,
        GEMINI_TEST_RESPONSE: agentResponse("Run the linter"),
      }
    )

    expect(result.decision).toBe("block")

    // Check prompt had no task section
    let capturedPrompt = ""
    try {
      capturedPrompt = await Bun.file(captureFile).text()
    } catch {}
    expect(capturedPrompt).not.toContain("=== SESSION TASKS ===")
  })

  test("combined tasks + transcript: suggestion incorporates both sources", async () => {
    const fakeHome = await createTempDir()
    await seedSettings(fakeHome)
    await writeTask(fakeHome, "1", "in_progress", "Implement auth flow")

    const captureDir = await createTempDir()
    const captureFile = join(captureDir, "prompt.txt")
    const workDir = await createTempDir()
    const transcriptPath = join(workDir, "transcript.jsonl")
    await writeFile(transcriptPath, buildTranscript(10))

    const result = await runHookRaw(
      { transcript_path: transcriptPath, session_id: "test-session", cwd: workDir },
      {
        HOME: fakeHome,
        GEMINI_API_KEY: "test-key",
        GEMINI_TEST_CAPTURE_FILE: captureFile,
        GEMINI_TEST_RESPONSE: agentResponse("Run the linter"),
      }
    )

    expect(result.decision).toBe("block")
    const capturedPrompt = await Bun.file(captureFile).text()
    // Both data sources present in the prompt
    expect(capturedPrompt).toContain("Implement auth flow (#1)")
    expect(capturedPrompt).toContain("CONVERSATION TRANSCRIPT")
  })
})
