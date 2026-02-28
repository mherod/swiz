import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

// ─── Constants ────────────────────────────────────────────────────────────────

const HOOK_PATH = resolve(process.cwd(), "hooks/stop-auto-continue.ts")
const BUN_EXE = Bun.which("bun") ?? "bun"

// ─── Temp dir cleanup ─────────────────────────────────────────────────────────

const tempDirs: string[] = []

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    await rm(dir, { recursive: true, force: true })
  }
})

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "swiz-auto-continue-integ-"))
  tempDirs.push(dir)
  return dir
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

/** Creates a fake `agent` binary that writes its args to a file then prints a suggestion. */
async function createArgCapturingAgent(binDir: string): Promise<string> {
  const argsFile = join(binDir, "captured-args.txt")
  const script =
    `#!/bin/sh\n` +
    `printf '%s\\n' "$@" > '${argsFile}'\n` +
    `printf '%s' 'Run the linter'\n` +
    `exit 0\n`
  await writeFile(join(binDir, "agent"), script)
  await chmod(join(binDir, "agent"), 0o755)
  return argsFile
}

/** Creates a fake `agent` that simply outputs a suggestion (no arg capture). */
async function createFakeAgent(binDir: string, output: string, exitCode = 0): Promise<void> {
  const script = `#!/bin/sh\nprintf '%s' '${output.replace(/'/g, "'\\''")}'\nexit ${exitCode}\n`
  await writeFile(join(binDir, "agent"), script)
  await chmod(join(binDir, "agent"), 0o755)
}

interface RunResult {
  decision?: string
  reason?: string
  rawOutput: string
}

/** Run the hook with a raw JSON payload (caller controls every field). */
async function runHookRaw(
  payload: Record<string, unknown>,
  binDir: string,
  extraEnv: Record<string, string> = {}
): Promise<RunResult> {
  const { CLAUDECODE: _cc, ...cleanEnv } = process.env
  const proc = Bun.spawn([BUN_EXE, HOOK_PATH], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...cleanEnv,
      PATH: `${binDir}:/bin:/usr/bin`,
      ...extraEnv,
    },
  })
  proc.stdin.write(JSON.stringify(payload))
  proc.stdin.end()

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
  test("exits silently when transcript_path is missing from input", async () => {
    const binDir = await createTempDir()
    await createFakeAgent(binDir, "Should never run")

    // No transcript_path key at all
    const result = await runHookRaw({ session_id: "test", cwd: "/tmp" }, binDir)

    expect(result.decision).toBeUndefined()
    expect(result.rawOutput.trim()).toBe("")
  })

  test("exits silently when transcript_path is null", async () => {
    const binDir = await createTempDir()
    await createFakeAgent(binDir, "Should never run")

    const result = await runHookRaw(
      { transcript_path: null, session_id: "test", cwd: "/tmp" },
      binDir
    )

    expect(result.decision).toBeUndefined()
    expect(result.rawOutput.trim()).toBe("")
  })

  test("exits silently when transcript file does not exist on disk", async () => {
    const binDir = await createTempDir()
    await createFakeAgent(binDir, "Should never run")

    const result = await runHookRaw(
      {
        transcript_path: "/nonexistent/path/transcript.jsonl",
        session_id: "test",
        cwd: "/tmp",
      },
      binDir
    )

    expect(result.decision).toBeUndefined()
    expect(result.rawOutput.trim()).toBe("")
  })

  test("exits silently when transcript contains no tool calls (all text turns)", async () => {
    const binDir = await createTempDir()
    await createFakeAgent(binDir, "Should never run")
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
      { transcript_path: transcriptPath, session_id: "test", cwd: workDir },
      binDir
    )

    // Zero tool calls → below MIN_TOOL_CALLS (5) → silent
    expect(result.decision).toBeUndefined()
  })
})

// ─── Threshold boundary ───────────────────────────────────────────────────────

describe("stop-auto-continue: MIN_TOOL_CALLS boundary", () => {
  test("4 tool calls → exits silently (below threshold)", async () => {
    const binDir = await createTempDir()
    await createFakeAgent(binDir, "Should not appear")
    const workDir = await createTempDir()
    const transcriptPath = join(workDir, "transcript.jsonl")
    await writeFile(transcriptPath, buildTranscript(4))

    const result = await runHookRaw(
      { transcript_path: transcriptPath, session_id: "test", cwd: workDir },
      binDir
    )

    expect(result.decision).toBeUndefined()
  })

  test("5 tool calls → blocks (at threshold)", async () => {
    const binDir = await createTempDir()
    await createFakeAgent(binDir, "Fix the failing test")
    const workDir = await createTempDir()
    const transcriptPath = join(workDir, "transcript.jsonl")
    await writeFile(transcriptPath, buildTranscript(5))

    const result = await runHookRaw(
      { transcript_path: transcriptPath, session_id: "test", cwd: workDir },
      binDir
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
    const tasksDir = join(fakeHome, ".claude", "tasks", sessionId)
    await mkdir(tasksDir, { recursive: true })
    await writeFile(join(tasksDir, `${id}.json`), JSON.stringify({ id, status, subject }))
  }

  test("SESSION TASKS block appears before CONVERSATION TRANSCRIPT in the prompt", async () => {
    const fakeHome = await createTempDir()
    await writeTask(fakeHome, "1", "completed", "Write tests")
    await writeTask(fakeHome, "2", "in_progress", "Fix types")

    const binDir = await createTempDir()
    const argsFile = await createArgCapturingAgent(binDir)
    const workDir = await createTempDir()
    const transcriptPath = join(workDir, "transcript.jsonl")
    await writeFile(transcriptPath, buildTranscript(10))

    await runHookRaw(
      { transcript_path: transcriptPath, session_id: "test-session", cwd: workDir },
      binDir,
      { HOME: fakeHome }
    )

    const capturedArgs = await Bun.file(argsFile).text()
    const tasksIdx = capturedArgs.indexOf("SESSION TASKS")
    const transcriptIdx = capturedArgs.indexOf("CONVERSATION TRANSCRIPT")
    expect(tasksIdx).toBeGreaterThan(-1)
    expect(transcriptIdx).toBeGreaterThan(-1)
    expect(tasksIdx).toBeLessThan(transcriptIdx)
  })

  test("COMPLETED tasks appear before IN PROGRESS tasks in the prompt", async () => {
    const fakeHome = await createTempDir()
    await writeTask(fakeHome, "1", "completed", "Done thing")
    await writeTask(fakeHome, "2", "in_progress", "Active thing")

    const binDir = await createTempDir()
    const argsFile = await createArgCapturingAgent(binDir)
    const workDir = await createTempDir()
    const transcriptPath = join(workDir, "transcript.jsonl")
    await writeFile(transcriptPath, buildTranscript(10))

    await runHookRaw(
      { transcript_path: transcriptPath, session_id: "test-session", cwd: workDir },
      binDir,
      { HOME: fakeHome }
    )

    const capturedArgs = await Bun.file(argsFile).text()
    const inProgressIdx = capturedArgs.indexOf("IN PROGRESS:")
    const completedIdx = capturedArgs.indexOf("COMPLETED:")
    expect(completedIdx).toBeGreaterThan(-1)
    expect(inProgressIdx).toBeGreaterThan(-1)
    expect(completedIdx).toBeLessThan(inProgressIdx)
  })

  test("empty session_id produces no SESSION TASKS block but still blocks", async () => {
    const binDir = await createTempDir()
    const argsFile = await createArgCapturingAgent(binDir)
    const workDir = await createTempDir()
    const transcriptPath = join(workDir, "transcript.jsonl")
    await writeFile(transcriptPath, buildTranscript(10))

    const result = await runHookRaw(
      { transcript_path: transcriptPath, session_id: "", cwd: workDir },
      binDir
    )

    expect(result.decision).toBe("block")

    // Check prompt had no task section
    let capturedArgs = ""
    try {
      capturedArgs = await Bun.file(argsFile).text()
    } catch {}
    expect(capturedArgs).not.toContain("=== SESSION TASKS ===")
  })

  test("combined tasks + transcript: suggestion incorporates both sources", async () => {
    const fakeHome = await createTempDir()
    await writeTask(fakeHome, "1", "in_progress", "Implement auth flow")

    const binDir = await createTempDir()
    // The fake agent echoes back the full prompt — let's check it contains both pieces
    const argsFile = await createArgCapturingAgent(binDir)
    const workDir = await createTempDir()
    const transcriptPath = join(workDir, "transcript.jsonl")
    await writeFile(transcriptPath, buildTranscript(10))

    const result = await runHookRaw(
      { transcript_path: transcriptPath, session_id: "test-session", cwd: workDir },
      binDir,
      { HOME: fakeHome }
    )

    expect(result.decision).toBe("block")
    const capturedArgs = await Bun.file(argsFile).text()
    // Both data sources present in the prompt
    expect(capturedArgs).toContain("Implement auth flow (#1)")
    expect(capturedArgs).toContain("CONVERSATION TRANSCRIPT")
  })
})
