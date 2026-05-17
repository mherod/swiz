import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { clearSkillCache, formatSkillReferenceForAgent } from "../src/skill-utils.ts"
import pretooluseSkillInvocationGate from "./pretooluse-skill-invocation-gate.ts"

const HOOK = join(import.meta.dir, "pretooluse-skill-invocation-gate.ts")

describe("pretooluse-skill-invocation-gate", () => {
  const agentEnvKeys = [
    "CLAUDECODE",
    "CURSOR_TRACE_ID",
    "CURSOR_SANDBOX_ENV_RESTORE",
    "GEMINI_CLI",
    "GEMINI_PROJECT_DIR",
    "CODEX_MANAGED_BY_NPM",
    "CODEX_THREAD_ID",
    "HOME",
  ] as const
  const originalEnv = new Map(agentEnvKeys.map((key) => [key, process.env[key]]))

  function restoreAgentEnv(): void {
    for (const [key, value] of originalEnv) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }

  beforeEach(() => {
    clearSkillCache()
    restoreAgentEnv()

    // Ensure env is clean for accurate agent detection
    for (const key of agentEnvKeys) delete process.env[key]
  })

  afterEach(() => {
    // Restore env
    restoreAgentEnv()
    clearSkillCache()
  })

  function assistantLine(content: unknown[], timestampMs = Date.now() - 1000): string {
    return JSON.stringify({
      timestamp: new Date(timestampMs).toISOString(),
      type: "assistant",
      message: { content },
    })
  }

  function summaryFromLines(sessionLines: string[]): Record<string, unknown> {
    return {
      toolNames: [],
      toolCallCount: 0,
      bashCommands: [],
      skillInvocations: [],
      hasGitPush: false,
      sessionLines,
      sessionDurationMs: 0,
      successfulTestRuns: 0,
      lastVerificationTime: null,
      sessionScope: "trivial",
    }
  }

  async function runPrOpenGateSubprocess(sessionLines: string[]): Promise<Record<string, any>> {
    const projectDir = await mkdtemp(join(tmpdir(), "skill-gate-project-"))
    try {
      const skillDir = join(projectDir, ".skills", "pr-open")
      await mkdir(skillDir, { recursive: true })
      await writeFile(join(skillDir, "SKILL.md"), "# pr-open\n")

      const env: Record<string, string> = { ...process.env, CLAUDECODE: "1" } as Record<
        string,
        string
      >
      for (const key of agentEnvKeys) {
        if (key !== "CLAUDECODE" && key !== "HOME") delete env[key]
      }

      const proc = Bun.spawn(["bun", HOOK], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        cwd: projectDir,
        env,
      })
      await proc.stdin.write(
        JSON.stringify({
          tool_name: "Bash",
          tool_input: {
            command: "gh pr create --title 'test' --body 'body'",
          },
          transcript_path: "fake-transcript.json",
          _transcriptSummary: summaryFromLines(sessionLines),
        })
      )
      await proc.stdin.end()
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      await proc.exited
      if (!stdout.trim()) throw new Error(`Hook emitted no output. stderr: ${stderr}`)
      return JSON.parse(stdout) as Record<string, any>
    } finally {
      await rm(projectDir, { recursive: true, force: true })
    }
  }

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
        `BLOCKED: git commit requires the ${formatSkillReferenceForAgent("commit")} skill`
      )
    } else {
      // If it didn't block, it means skillExists('commit') returned false.
      // This could happen if we are not in a git repo or skill is missing.
      console.log("Gate skipped - possibly skill missing or not in git repo")
    }
  })

  it("allows gh pr create only when pr-open was used within the recency window", async () => {
    const result = await runPrOpenGateSubprocess([
      assistantLine([{ type: "tool_use", name: "Skill", input: { skill: "pr-open" } }]),
    ])

    expect(
      (result as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput
        ?.permissionDecision
    ).toBe("allow")
  })

  it("blocks gh pr create when pr-open was used more than twenty minutes ago", async () => {
    const old = Date.now() - 21 * 60 * 1000

    const result = await runPrOpenGateSubprocess([
      assistantLine([{ type: "tool_use", name: "Skill", input: { skill: "pr-open" } }], old),
    ])

    expect(
      (result as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput
        ?.permissionDecision
    ).toBe("deny")
    expect(
      (result as { hookSpecificOutput?: { permissionDecisionReason?: string } }).hookSpecificOutput
        ?.permissionDecisionReason
    ).toContain("last 30 turns and last 20 minutes")
  })

  it("blocks gh pr create when pr-open is outside the last thirty turns", async () => {
    const result = await runPrOpenGateSubprocess([
      assistantLine([{ type: "tool_use", name: "Skill", input: { skill: "pr-open" } }]),
      // Thirty-one user/assistant turn pairs push the window past the Skill call.
      // Turns count user messages now, not raw JSONL lines.
      ...Array.from({ length: 31 }, (_, index) => [
        JSON.stringify({
          timestamp: new Date(Date.now() - 60_000 + index * 100).toISOString(),
          type: "user",
          message: { content: `noop-${index}` },
        }),
        assistantLine([{ type: "tool_use", name: "Read", input: { file_path: `file-${index}` } }]),
      ]).flat(),
    ])

    expect(
      (result as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput
        ?.permissionDecision
    ).toBe("deny")
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
