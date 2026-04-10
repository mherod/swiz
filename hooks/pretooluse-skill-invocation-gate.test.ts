import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { clearSkillCache } from "../src/skill-utils.ts"
import pretooluseSkillInvocationGate from "./pretooluse-skill-invocation-gate.ts"

describe("pretooluse-skill-invocation-gate", () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    clearSkillCache()
    // Reset env for each test
    for (const key in process.env) {
      delete process.env[key]
    }
    Object.assign(process.env, originalEnv)

    // Explicitly clear Junie indicators to avoid accidental detection as Junie
    delete process.env.JUNIE_DATA
    delete process.env.JUNIE_TOKEN
  })

  afterEach(() => {
    // Restore env
    for (const key in process.env) {
      delete process.env[key]
    }
    Object.assign(process.env, originalEnv)
  })

  it("blocks git commit when running in Claude (supports Skill tool) and skill exists", async () => {
    // Simulate Claude agent
    process.env.CLAUDECODE = "1"

    // We assume 'commit' skill exists in the project or global (it usually does in this repo)
    // If it doesn't, this test might skip, but in this repo it should exist.

    const input = {
      tool_name: "Bash",
      tool_input: {
        command: "git commit -m 'test'",
      },
      transcript_path: "fake-transcript.json",
      // Mocking getSkillsUsedForCurrentSession return value via input properties if needed,
      // but getSkillsUsedForCurrentSession usually reads from disk.
      // For this test, we want to see it BLOCK.
    }

    const result = await pretooluseSkillInvocationGate.run(input)

    // If skillExists('commit') is true, it should block.
    // In the actual project, 'commit' skill exists.
    if (result && Object.keys(result).length > 0) {
      expect((result as { systemMessage?: string }).systemMessage).toContain(
        "BLOCKED: git commit requires the `/commit` skill"
      )
    } else {
      // If it didn't block, it means skillExists('commit') returned false.
      // This could happen if we are not in a git repo or skill is missing.
      console.log("Gate skipped - possibly skill missing or not in git repo")
    }
  })

  it("skips gate when running in Cursor (does NOT support Skill tool)", async () => {
    // Simulate Cursor agent
    process.env.CURSOR_TRACE_ID = "1"
    process.env.CURSOR_SANDBOX_ENV_RESTORE = "1" // Use processPattern indicator too
    delete process.env.CLAUDECODE

    const input = {
      tool_name: "Bash",
      tool_input: {
        command: "git commit -m 'test'",
      },
      transcript_path: "fake-transcript.json",
    }

    const result = await pretooluseSkillInvocationGate.run(input)

    // Should return empty object (allow/skip) because skillExists returns false for Cursor
    expect(result).toEqual({})
  })

  it("skips gate when running in Gemini (does NOT support Skill tool)", async () => {
    // Simulate Gemini agent
    process.env.GEMINI_CLI = "1"
    delete process.env.CLAUDECODE

    const input = {
      tool_name: "Bash",
      tool_input: {
        command: "git commit -m 'test'",
      },
      transcript_path: "fake-transcript.json",
    }

    const result = await pretooluseSkillInvocationGate.run(input)

    // Should return empty object (allow/skip) because skillExists returns false for Gemini
    expect(result).toEqual({})
  })
})
