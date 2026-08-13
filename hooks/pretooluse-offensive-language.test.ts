import { describe, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { getAutoSteerStore, resetAutoSteerStore } from "../src/auto-steer-store.ts"
import {
  acquireEnvLock,
  releaseEnvLockFn,
  runHookInProcess,
  useTempDir,
} from "../src/utils/test-utils.ts"
import { evaluatePretooluseOffensiveLanguage } from "./pretooluse-offensive-language.ts"

const HOOK = "hooks/pretooluse-offensive-language.ts"
const { create: createTempDir } = useTempDir("swiz-offensive-language-")

async function writeTranscript(dir: string, content: unknown): Promise<string> {
  const path = join(dir, "transcript.jsonl")
  await Bun.write(path, `${JSON.stringify(content)}\n`)
  return path
}

function assistantMessage(text: string): Record<string, unknown> {
  return {
    type: "assistant",
    message: { content: [{ type: "text", text }] },
  }
}

describe("pretooluse-offensive-language", () => {
  test("stays silent without a transcript or avoidance phrase", async () => {
    const dir = await createTempDir()
    const transcriptPath = await writeTranscript(dir, assistantMessage("Implementation complete."))

    const missingTranscript = await runHookInProcess(HOOK, { tool_name: "Bash" })
    const cleanMessage = await runHookInProcess(
      HOOK,
      { tool_name: "Bash", transcript_path: transcriptPath },
      { env: { AI_TEST_NO_BACKEND: "1" } }
    )

    expect(missingTranscript.stdout).toBe("")
    expect(cleanMessage.stdout).toBe("")
  })

  test("fails open for malformed input", async () => {
    const result = await runHookInProcess(HOOK, { tool_name: 42 })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe("")
  })

  test("fails open when steering delivery is unavailable", async () => {
    const dir = await createTempDir()
    const transcriptPath = await writeTranscript(
      dir,
      assistantMessage("Would you like me to implement the requested change?")
    )
    const result = await runHookInProcess(
      HOOK,
      {
        cwd: dir,
        session_id: "issue-783-offensive-language",
        tool_name: "Bash",
        tool_input: { command: "git status" },
        transcript_path: transcriptPath,
      },
      {
        env: {
          AI_TEST_NO_BACKEND: "1",
          TERM_PROGRAM: undefined,
          __CFBundleIdentifier: undefined,
        },
      }
    )

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe("")
  })

  test("schedules corrective steering when delivery is available", async () => {
    await acquireEnvLock()
    const originalHome = process.env.HOME
    const originalTermProgram = process.env.TERM_PROGRAM
    const originalNoBackend = process.env.AI_TEST_NO_BACKEND
    const dir = await createTempDir()
    const sessionId = "issue-783-offensive-language-success"

    try {
      resetAutoSteerStore()
      process.env.HOME = dir
      process.env.TERM_PROGRAM = "Apple_Terminal"
      process.env.AI_TEST_NO_BACKEND = "1"
      await mkdir(join(dir, ".swiz"), { recursive: true })
      await Bun.write(
        join(dir, ".swiz", "settings.json"),
        JSON.stringify({ autoSteer: true, humaniseAutoSteer: false })
      )
      const transcriptPath = await writeTranscript(
        dir,
        assistantMessage("Would you like me to implement the requested change?")
      )

      const output = await evaluatePretooluseOffensiveLanguage({
        cwd: dir,
        session_id: sessionId,
        tool_name: "Bash",
        tool_input: { command: "git status" },
        transcript_path: transcriptPath,
      })
      const queued = getAutoSteerStore().consumeOne(sessionId, "next_turn")

      expect(output).toEqual({})
      expect(queued).toHaveLength(1)
      expect(queued[0]?.message).toContain("Demonstrate corrected behavior through action")
    } finally {
      resetAutoSteerStore()
      if (originalHome === undefined) delete process.env.HOME
      else process.env.HOME = originalHome
      if (originalTermProgram === undefined) delete process.env.TERM_PROGRAM
      else process.env.TERM_PROGRAM = originalTermProgram
      if (originalNoBackend === undefined) delete process.env.AI_TEST_NO_BACKEND
      else process.env.AI_TEST_NO_BACKEND = originalNoBackend
      releaseEnvLockFn()
    }
  })
})
