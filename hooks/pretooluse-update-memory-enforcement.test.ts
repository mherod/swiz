import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const HOOK = "hooks/pretooluse-update-memory-enforcement.ts"
const REMINDER_FRAGMENT =
  "record a DO or DON'T rule that proactively builds the required steps into your standard development workflow."
const SELF_SENTINEL = "MEMORY CAPTURE ENFORCEMENT"

const tempDirs: string[] = []

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (!dir) continue
    await rm(dir, { recursive: true, force: true })
  }
})

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "swiz-update-memory-"))
  tempDirs.push(dir)
  return dir
}

async function createTranscript(dir: string, lines: unknown[]): Promise<string> {
  const path = join(dir, "transcript.jsonl")
  await writeFile(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`)
  return path
}

interface HookResult {
  exitCode: number | null
  stdout: string
  json: Record<string, unknown> | null
}

async function runHook(stdinPayload: Record<string, unknown>): Promise<HookResult> {
  const proc = Bun.spawn(["bun", HOOK], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  })
  proc.stdin.write(JSON.stringify(stdinPayload))
  proc.stdin.end()

  const stdout = await new Response(proc.stdout).text()
  await proc.exited

  let json: Record<string, unknown> | null = null
  try {
    if (stdout.trim()) json = JSON.parse(stdout.trim())
  } catch {}

  return { exitCode: proc.exitCode, stdout: stdout.trim(), json }
}

function hookFeedback(text: string): Record<string, unknown> {
  return {
    type: "user",
    message: {
      content: `Stop hook feedback: ${text}`,
    },
  }
}

function toolUse(name: string, input: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "assistant",
    message: {
      content: [{ type: "tool_use", name, input }],
    },
  }
}

describe("pretooluse-update-memory-enforcement", () => {
  test("denies normal work until the update-memory skill is read", async () => {
    const dir = await createTempDir()
    const transcript = await createTranscript(dir, [
      hookFeedback(`Use the /update-memory skill to ${REMINDER_FRAGMENT}`),
    ])

    const result = await runHook({
      cwd: dir,
      tool_name: "Edit",
      tool_input: { file_path: "src/app.ts", new_string: "export const x = 1\n" },
      transcript_path: transcript,
    })

    expect(result.exitCode).toBe(0)
    const hso = result.json?.hookSpecificOutput as Record<string, unknown>
    expect(hso?.permissionDecision).toBe("deny")
    expect(String(hso?.permissionDecisionReason)).toContain(SELF_SENTINEL)
    expect(String(hso?.permissionDecisionReason)).toContain("Read the /update-memory skill")
  })

  test("allows reading the update-memory skill after the reminder", async () => {
    const dir = await createTempDir()
    const transcript = await createTranscript(dir, [
      hookFeedback(`Use the /update-memory skill to ${REMINDER_FRAGMENT}`),
    ])

    const result = await runHook({
      tool_name: "Bash",
      tool_input: {
        command: "sed -n '1,200p' /Users/test/.codex/skills/update-memory/SKILL.md",
      },
      transcript_path: transcript,
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe("")
  })

  test("allows the markdown write once the skill read is already in the transcript", async () => {
    const dir = await createTempDir()
    const transcript = await createTranscript(dir, [
      hookFeedback(`Use the /update-memory skill to ${REMINDER_FRAGMENT}`),
      toolUse("Read", { file_path: "/Users/test/.codex/skills/update-memory/SKILL.md" }),
    ])

    const result = await runHook({
      tool_name: "Edit",
      tool_input: { file_path: "CLAUDE.md", new_string: "DO: update memory immediately.\n" },
      transcript_path: transcript,
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe("")
  })

  test("allows normal work after the reminder has already been satisfied", async () => {
    const dir = await createTempDir()
    const transcript = await createTranscript(dir, [
      hookFeedback(`Use the /update-memory skill to ${REMINDER_FRAGMENT}`),
      toolUse("Read", { file_path: "/Users/test/.codex/skills/update-memory/SKILL.md" }),
      toolUse("Write", {
        file_path: "CLAUDE.md",
        content: "DO: update memory immediately.\n",
      }),
    ])

    const result = await runHook({
      tool_name: "Edit",
      tool_input: { file_path: "src/app.ts", new_string: "export const y = 2\n" },
      transcript_path: transcript,
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe("")
  })

  test("allows the markdown write even when the skill read is not yet in the transcript (same-turn case)", async () => {
    // Reproduces the deadlock: skill Read and Edit happen in the same response turn,
    // so the transcript hasn't captured the skill Read yet when the Edit hook fires.
    const dir = await createTempDir()
    const transcript = await createTranscript(dir, [
      hookFeedback(`Use the /update-memory skill to ${REMINDER_FRAGMENT}`),
      // Skill read is absent — simulating the same-turn case where the transcript
      // hasn't been written yet for the current assistant turn.
    ])

    const result = await runHook({
      tool_name: "Edit",
      tool_input: { file_path: "CLAUDE.md", new_string: "DO: update memory immediately.\n" },
      transcript_path: transcript,
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe("")
  })

  test("ignores its own prior denials when locating the active reminder", async () => {
    const dir = await createTempDir()
    const transcript = await createTranscript(dir, [
      hookFeedback(`Use the /update-memory skill to ${REMINDER_FRAGMENT}`),
      toolUse("Read", { file_path: "/Users/test/.codex/skills/update-memory/SKILL.md" }),
      hookFeedback(
        `${SELF_SENTINEL}: still pending. Use the /update-memory skill to ${REMINDER_FRAGMENT}`
      ),
    ])

    const result = await runHook({
      tool_name: "Edit",
      tool_input: {
        file_path: "CLAUDE.md",
        new_string: "DO: record the rule before continuing.\n",
      },
      transcript_path: transcript,
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe("")
  })

  test("skips enforcement when a CLAUDE.md in cwd was modified within the cooldown window", async () => {
    const dir = await createTempDir()
    // Write a fresh CLAUDE.md into the temp dir — mtime will be "now"
    const { writeFile } = await import("node:fs/promises")
    await writeFile(`${dir}/CLAUDE.md`, "DO: update memory immediately.\n")

    const transcript = await createTranscript(dir, [
      hookFeedback(`Use the /update-memory skill to ${REMINDER_FRAGMENT}`),
      // No skill read, no markdown write in transcript — but cooldown should bypass
    ])

    const result = await runHook({
      cwd: dir,
      tool_name: "Edit",
      tool_input: { file_path: "src/app.ts", new_string: "export const z = 3\n" },
      transcript_path: transcript,
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe("") // allowed — cooldown active
  })
})
