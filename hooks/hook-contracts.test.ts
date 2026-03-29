import { describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { manifest } from "../src/manifest.ts"
import { getSessionTasksDir } from "../src/tasks/task-recovery.ts"
import { type JsonObject, useTempDir } from "../src/utils/test-utils.ts"
import { hookOutputSchema } from "./schemas.ts"

const HOOK_CONTRACT_TIMEOUT_MS = 30_000

const _tmp = useTempDir()

function assertHookOutputShape(output: JsonObject): void {
  const result = hookOutputSchema.safeParse(output)
  expect(result.success).toBe(true)
}

async function runHookScript(
  file: string
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const homeDir = await _tmp.create("swiz-hook-contract-home-")
  const cwdDir = await _tmp.create("swiz-hook-contract-cwd-")
  const transcriptPath = join(cwdDir, "transcript.jsonl")
  const sourceFile = join(cwdDir, "file.ts")

  await writeFile(
    transcriptPath,
    `${JSON.stringify({ type: "user", message: { content: "hello" } })}\n`
  )
  await writeFile(sourceFile, "export const value = 1;\n")

  // Ensure require-tasks can pass when needed.
  const sessionId = `session-${Date.now()}-${Math.random().toString(16).slice(2)}`
  const tasksDir = getSessionTasksDir(sessionId, homeDir)
  if (!tasksDir) throw new Error("Failed to resolve session tasks directory")
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
    env: {
      ...process.env,
      HOME: homeDir,
      // Keep hook contract tests deterministic and fast for hooks that can call AI.
      AI_TEST_NO_BACKEND: "1",
    },
  })

  void proc.stdin.write(JSON.stringify(payload))
  void proc.stdin.end()

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
    test(
      `${file} exits successfully and emits valid JSON when output is present`,
      async () => {
        const result = await runHookScript(file)
        expect(result.exitCode).toBe(0)

        if (!result.stdout) return

        let parsed: JsonObject
        expect(() => {
          parsed = JSON.parse(result.stdout) as JsonObject
        }).not.toThrow()

        parsed = JSON.parse(result.stdout) as JsonObject
        assertHookOutputShape(parsed)
      },
      HOOK_CONTRACT_TIMEOUT_MS
    )
  }
})
