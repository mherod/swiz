import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import pretooluseStuckState from "./pretooluse-stuck-state.ts"

const HOOK = join(import.meta.dir, "pretooluse-stuck-state.ts")
const NOW_MS = Date.parse("2026-05-09T12:00:00.000Z")

interface HookResult {
  exitCode: number | null
  stdout: string
  reason: string
}

function atMinutesAgo(minutes: number): string {
  return new Date(NOW_MS - minutes * 60_000).toISOString()
}

function assistantTool(
  id: string,
  name: string,
  input: Record<string, any>,
  minutesAgo: number
): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: atMinutesAgo(minutesAgo),
    message: { content: [{ type: "tool_use", id, name, input }] },
  })
}

function toolResult(id: string, success: boolean, minutesAgo: number): string {
  return JSON.stringify({
    type: "user",
    timestamp: atMinutesAgo(minutesAgo),
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: id,
          is_error: !success,
          content: success ? "ok" : "exit status 1",
        },
      ],
    },
  })
}

async function createTranscript(lines: string[]): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "swiz-stuck-state-"))
  const path = join(dir, "transcript.jsonl")
  await Bun.write(path, `${lines.join("\n")}\n`)
  return { dir, path }
}

async function runHook(
  transcriptPath: string,
  input: Record<string, any>,
  effectiveSettings: Record<string, any> = { enforceUnblockMyself: true }
): Promise<HookResult> {
  const proc = Bun.spawn(["bun", HOOK], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    cwd: process.cwd(),
    env: { ...process.env },
  })
  await proc.stdin.write(
    JSON.stringify({
      cwd: process.cwd(),
      session_id: "stuck-state-test",
      transcript_path: transcriptPath,
      _testNowMs: NOW_MS,
      _effectiveSettings: effectiveSettings,
      ...input,
    })
  )
  await proc.stdin.end()
  const [stdout] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited

  const trimmed = stdout.trim()
  const parsed = trimmed ? (JSON.parse(trimmed) as Record<string, any>) : {}
  return {
    exitCode: proc.exitCode,
    stdout: trimmed,
    reason: String(parsed.hookSpecificOutput?.permissionDecisionReason ?? ""),
  }
}

async function withTranscript<T>(lines: string[], fn: (path: string) => Promise<T>): Promise<T> {
  const { dir, path } = await createTranscript(lines)
  try {
    return await fn(path)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe("pretooluse-stuck-state", () => {
  test("repeat-edit without commit blocks", async () => {
    const lines = Array.from({ length: 5 }, (_, index) => {
      const id = `edit-${index}`
      return [
        assistantTool(id, "Edit", { file_path: "src/app.ts" }, 19 - index),
        toolResult(id, true, 19 - index),
      ]
    }).flat()

    await withTranscript(lines, async (path) => {
      const result = await runHook(path, {
        tool_name: "Edit",
        tool_input: { file_path: "src/app.ts" },
      })

      expect(result.exitCode).toBe(0)
      expect(result.reason).toContain("same file edited 6 times in 20 minutes without commit")
      expect(result.reason).toContain("/unblock-myself")
    })
  })

  test("repeat-Bash failure blocks", async () => {
    const command = "bun test src/failing.test.ts"
    const lines = [0, 1, 2].flatMap((index) => {
      const id = `bash-${index}`
      return [assistantTool(id, "Bash", { command }, 6 - index), toolResult(id, false, 6 - index)]
    })

    await withTranscript(lines, async (path) => {
      const result = await runHook(path, {
        tool_name: "Bash",
        tool_input: { command },
      })

      expect(result.exitCode).toBe(0)
      expect(result.reason).toContain("same Bash command failed 4 times")
    })
  })

  test("idle no-forward-progress blocks", async () => {
    const lines = [
      assistantTool("bash-old", "Bash", { command: "bun test old.test.ts" }, 25),
      toolResult("bash-old", false, 25),
    ]

    await withTranscript(lines, async (path) => {
      const result = await runHook(path, {
        tool_name: "Bash",
        tool_input: { command: "echo next" },
      })

      expect(result.exitCode).toBe(0)
      expect(result.reason).toContain("no forward progress in 25 minutes")
    })
  })

  test("recent unblock skill invocation allows", async () => {
    const command = "bun test src/failing.test.ts"
    const lines = [
      assistantTool("bash-1", "Bash", { command }, 15),
      toolResult("bash-1", false, 15),
      assistantTool("bash-2", "Bash", { command }, 14),
      toolResult("bash-2", false, 14),
      assistantTool("bash-3", "Bash", { command }, 13),
      toolResult("bash-3", false, 13),
      assistantTool("skill-1", "Skill", { skill: "unblock-myself" }, 1),
      toolResult("skill-1", true, 1),
    ]

    await withTranscript(lines, async (path) => {
      const result = await runHook(path, {
        tool_name: "Bash",
        tool_input: { command },
      })

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe("")
    })
  })

  test("setting opt-out allows", async () => {
    const lines = Array.from({ length: 5 }, (_, index) => {
      const id = `edit-disabled-${index}`
      return [
        assistantTool(id, "Edit", { file_path: "src/app.ts" }, 19 - index),
        toolResult(id, true, 19 - index),
      ]
    }).flat()

    await withTranscript(lines, async (path) => {
      const result = await runHook(
        path,
        {
          tool_name: "Edit",
          tool_input: { file_path: "src/app.ts" },
        },
        { enforceUnblockMyself: false }
      )

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe("")
    })
  })

  test("cooldown behavior is declared for dispatcher enforcement", () => {
    expect(pretooluseStuckState.cooldownSeconds).toBe(600)
    expect(pretooluseStuckState.requiredSettings).toEqual(["enforceUnblockMyself"])
    expect(pretooluseStuckState.matcher).toBe("Edit|Write|Bash")
  })
})
