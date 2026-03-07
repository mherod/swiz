import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { manifest } from "../src/manifest.ts"

type JsonObject = Record<string, unknown>

const tempDirs: string[] = []

afterAll(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (!dir) continue
    await rm(dir, { recursive: true, force: true })
  }
})

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function assertHookOutputShape(output: JsonObject): void {
  // All hooks in this repo should return one of the known control envelopes.
  const hasKnownShape =
    "decision" in output ||
    "hookSpecificOutput" in output ||
    "ok" in output ||
    "continue" in output ||
    "systemMessage" in output

  expect(hasKnownShape).toBe(true)

  if ("decision" in output) {
    expect(typeof output.decision).toBe("string")
    // Claude Code only accepts "approve" or "block" for the top-level decision
    // field. "deny" is invalid and causes schema validation failure, which
    // silently ignores the hook response. Use hookSpecificOutput.permissionDecision
    // for PreToolUse denials instead.
    expect(["approve", "block"]).toContain(output.decision as string)
  }

  if ("hookSpecificOutput" in output) {
    const hso = output.hookSpecificOutput as JsonObject
    expect(typeof hso).toBe("object")
    expect(typeof hso.hookEventName).toBe("string")
  }

  if ("ok" in output) {
    expect(typeof output.ok).toBe("boolean")
  }
}

async function runHookScript(
  file: string
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const homeDir = await createTempDir("swiz-hook-contract-home-")
  const cwdDir = await createTempDir("swiz-hook-contract-cwd-")
  const transcriptPath = join(cwdDir, "transcript.jsonl")
  const sourceFile = join(cwdDir, "file.ts")

  await writeFile(
    transcriptPath,
    `${JSON.stringify({ type: "user", message: { content: "hello" } })}\n`
  )
  await writeFile(sourceFile, "export const value = 1;\n")

  // Ensure require-tasks can pass when needed.
  const sessionId = `session-${Date.now()}-${Math.random().toString(16).slice(2)}`
  const tasksDir = join(homeDir, ".claude", "tasks", sessionId)
  await mkdir(tasksDir, { recursive: true })
  await writeFile(
    join(tasksDir, "1.json"),
    JSON.stringify(
      {
        id: "1",
        subject: "Contract test task",
        description: "Ensures hook contract tests can run.",
        status: "in_progress",
        blocks: [],
        blockedBy: [],
      },
      null,
      2
    )
  )

  const payload = {
    session_id: sessionId,
    transcript_path: transcriptPath,
    cwd: cwdDir,
    permission_mode: "default",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_use_id: "toolu_test_contract",
    tool_input: {
      command: "echo hook-contract",
      file_path: sourceFile,
      old_string: "value = 1",
      new_string: "value = 2",
      content: '{"name":"test"}',
      subject: "Single concern task",
      prompt: "Inspect this task",
      path: cwdDir,
    },
    tool_response: { success: true },
    stop_hook_active: false,
    last_assistant_message: "Done.",
    matcher: "compact",
    trigger: "compact",
    source: "compact",
    prompt: "Please continue",
  }

  const proc = Bun.spawn(["bun", `hooks/${file}`], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HOME: homeDir },
  })

  proc.stdin.write(JSON.stringify(payload))
  proc.stdin.end()

  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  await proc.exited

  return { exitCode: proc.exitCode, stdout: stdout.trim(), stderr: stderr.trim() }
}

describe("hook scripts contracts", () => {
  const hookFiles = [
    ...new Set(manifest.flatMap((group) => group.hooks.map((hook) => hook.file))),
  ].sort()

  for (const file of hookFiles) {
    test(`${file} exits successfully and emits valid JSON when output is present`, async () => {
      const result = await runHookScript(file)
      expect(result.exitCode).toBe(0)

      if (!result.stdout) return

      let parsed: JsonObject
      expect(() => {
        parsed = JSON.parse(result.stdout) as JsonObject
      }).not.toThrow()

      parsed = JSON.parse(result.stdout) as JsonObject
      assertHookOutputShape(parsed)
    })
  }
})
