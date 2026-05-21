import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { clearSkillCache } from "../src/skill-utils.ts"
import { skillRequirementCooldownPath } from "../src/temp-paths.ts"
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

  async function runGit(dir: string, args: string[]): Promise<void> {
    const proc = Bun.spawn(["git", ...args], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    })
    await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    await proc.exited
    if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`)
  }

  async function runGateSubprocess(
    skillName: string,
    payload: object,
    setupProject?: (projectDir: string) => Promise<void>
  ): Promise<Record<string, any>> {
    const projectDir = await mkdtemp(join(tmpdir(), "gate-subprocess-"))
    try {
      const skillDir = join(projectDir, ".skills", skillName)
      await mkdir(skillDir, { recursive: true })
      await writeFile(join(skillDir, "SKILL.md"), `# ${skillName}\n`)
      await setupProject?.(projectDir)

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
      await proc.stdin.write(JSON.stringify(payload))
      await proc.stdin.end()
      const [stdout] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      await proc.exited
      if (!stdout.trim()) return {}
      return JSON.parse(stdout) as Record<string, any>
    } finally {
      await rm(projectDir, { recursive: true, force: true })
    }
  }

  async function runPrOpenGateSubprocess(sessionLines: string[]): Promise<Record<string, any>> {
    return await runGateSubprocess("pr-open", {
      tool_name: "Bash",
      tool_input: { command: "gh pr create --title 'test' --body 'body'" },
      transcript_path: "fake-transcript.json",
      _transcriptSummary: summaryFromLines(sessionLines),
    })
  }

  it("blocks git commit when commit skill is installed and no prior skill invocation", async () => {
    const result = await runGateSubprocess("commit", {
      tool_name: "Bash",
      tool_input: { command: "git commit -m 'test'" },
      transcript_path: "fake-transcript.json",
      _transcriptSummary: summaryFromLines([]),
    })

    expect(
      (result as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput
        ?.permissionDecision
    ).toBe("deny")
    expect((result as { systemMessage?: string }).systemMessage).toContain("BLOCKED")
  })

  it("allows git commit when commit skill and TaskList were recently invoked", async () => {
    const sessionLines = [
      assistantLine([{ type: "tool_use", name: "Skill", input: { skill: "commit" } }]),
      assistantLine([{ type: "tool_use", name: "TaskList" }]),
    ]
    const result = await runGateSubprocess("commit", {
      tool_name: "Bash",
      tool_input: { command: "git commit -m 'test'" },
      transcript_path: "fake-transcript.json",
      _transcriptSummary: {
        ...summaryFromLines(sessionLines),
        toolNames: ["TaskList"],
      },
    })

    expect(
      (result as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput
        ?.permissionDecision
    ).toBe("allow")
  })

  it("blocks Claude git commit when commit skill was used but TaskList was not synced", async () => {
    const sessionLines = [
      assistantLine([{ type: "tool_use", name: "Skill", input: { skill: "commit" } }]),
    ]
    const result = await runGateSubprocess("commit", {
      tool_name: "Bash",
      tool_input: { command: "git commit -m 'test'" },
      transcript_path: "fake-transcript.json",
      _transcriptSummary: summaryFromLines(sessionLines),
    })

    expect(
      (result as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput
        ?.permissionDecision
    ).toBe("deny")
    expect((result as { systemMessage?: string }).systemMessage).toContain("requires TaskList")
  })

  it("blocks git commit when git config identity is a placeholder", async () => {
    const sessionLines = [
      assistantLine([{ type: "tool_use", name: "Skill", input: { skill: "commit" } }]),
      assistantLine([{ type: "tool_use", name: "TaskList" }]),
    ]

    const result = await runGateSubprocess(
      "commit",
      {
        tool_name: "Bash",
        tool_input: { command: "git commit -m 'test'" },
        transcript_path: "fake-transcript.json",
        _transcriptSummary: {
          ...summaryFromLines(sessionLines),
          toolNames: ["TaskList"],
        },
      },
      async (projectDir) => {
        await runGit(projectDir, ["init"])
        await runGit(projectDir, ["config", "user.name", "Test"])
        await runGit(projectDir, ["config", "user.email", "test@test.com"])
      }
    )

    expect(
      (result as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput
        ?.permissionDecision
    ).toBe("deny")
    expect((result as { systemMessage?: string }).systemMessage).toContain(
      "git commit author identity is not valid"
    )
  })

  it("blocks git commit when command overrides user.name or user.email", async () => {
    const result = await runGateSubprocess("commit", {
      tool_name: "Bash",
      tool_input: { command: "git -c user.name=Test commit -m 'test'" },
      transcript_path: "fake-transcript.json",
      _transcriptSummary: summaryFromLines([]),
    })

    expect(
      (result as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput
        ?.permissionDecision
    ).toBe("deny")
    expect((result as { systemMessage?: string }).systemMessage).toContain(
      "git commit cannot override user.name or user.email"
    )
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

  async function runPrMergeGateSubprocess(sessionLines: string[]): Promise<Record<string, any>> {
    return await runGateSubprocess("pr-qa-and-merge", {
      tool_name: "Bash",
      tool_input: { command: "gh pr merge 42 --squash" },
      transcript_path: "fake-transcript.json",
      _transcriptSummary: summaryFromLines(sessionLines),
    })
  }

  it("blocks gh pr merge when pr-merge skill was not used recently", async () => {
    const result = await runPrMergeGateSubprocess([])

    expect(
      (result as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput
        ?.permissionDecision
    ).toBe("deny")
    expect((result as { systemMessage?: string }).systemMessage).toContain("BLOCKED")
  })

  it("allows gh pr merge when pr-merge skill was used recently", async () => {
    const result = await runPrMergeGateSubprocess([
      assistantLine([{ type: "tool_use", name: "Skill", input: { skill: "pr-qa-and-merge" } }]),
    ])

    expect(
      (result as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput
        ?.permissionDecision
    ).toBe("allow")
  })

  it("blocks gh pr merge when pr-merge skill was used more than twenty minutes ago", async () => {
    const old = Date.now() - 21 * 60 * 1000

    const result = await runPrMergeGateSubprocess([
      assistantLine(
        [{ type: "tool_use", name: "Skill", input: { skill: "pr-qa-and-merge" } }],
        old
      ),
    ])

    expect(
      (result as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput
        ?.permissionDecision
    ).toBe("deny")
  })

  async function runPrCheckoutGateSubprocess(sessionLines: string[]): Promise<Record<string, any>> {
    return await runGateSubprocess("pr-qa-and-merge", {
      tool_name: "Bash",
      tool_input: { command: "gh pr checkout 42" },
      transcript_path: "fake-transcript.json",
      _transcriptSummary: summaryFromLines(sessionLines),
    })
  }

  it("blocks gh pr checkout when no qualifying skill was used recently", async () => {
    const result = await runPrCheckoutGateSubprocess([])

    expect(
      (result as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput
        ?.permissionDecision
    ).toBe("deny")
    expect((result as { systemMessage?: string }).systemMessage).toContain("BLOCKED")
  })

  it("allows gh pr checkout when pr-qa-and-merge was used recently", async () => {
    const result = await runPrCheckoutGateSubprocess([
      assistantLine([{ type: "tool_use", name: "Skill", input: { skill: "pr-qa-and-merge" } }]),
    ])

    expect(
      (result as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput
        ?.permissionDecision
    ).toBe("allow")
  })

  it("allows gh pr checkout when pr-comments-address was used recently", async () => {
    const result = await runPrCheckoutGateSubprocess([
      assistantLine([{ type: "tool_use", name: "Skill", input: { skill: "pr-comments-address" } }]),
    ])

    expect(
      (result as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput
        ?.permissionDecision
    ).toBe("allow")
  })

  it("allows gh pr checkout when work-on-issue was used recently", async () => {
    const result = await runPrCheckoutGateSubprocess([
      assistantLine([{ type: "tool_use", name: "Skill", input: { skill: "work-on-issue" } }]),
    ])

    expect(
      (result as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput
        ?.permissionDecision
    ).toBe("allow")
  })

  async function runLabelGateSubprocess(
    command: string,
    sessionLines: string[] = []
  ): Promise<Record<string, any>> {
    return await runGateSubprocess("refine-issue", {
      tool_name: "Bash",
      tool_input: { command },
      transcript_path: "fake-transcript.json",
      _transcriptSummary: summaryFromLines(sessionLines),
    })
  }

  describe("refine-issue gate — readiness label scoping", () => {
    it("allows --add-label backlog without /refine-issue (readiness label)", async () => {
      const result = await runLabelGateSubprocess("gh issue edit 630 --add-label backlog")
      expect(
        (result as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput
          ?.permissionDecision
      ).not.toBe("deny")
    })

    it("allows --add-label ready without /refine-issue (readiness label)", async () => {
      const result = await runLabelGateSubprocess("gh issue edit 630 --add-label ready")
      expect(
        (result as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput
          ?.permissionDecision
      ).not.toBe("deny")
    })

    it("allows --remove-label backlog without /refine-issue (readiness label)", async () => {
      const result = await runLabelGateSubprocess("gh issue edit 630 --remove-label backlog")
      expect(
        (result as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput
          ?.permissionDecision
      ).not.toBe("deny")
    })

    it("blocks --add-label bug without /refine-issue (type label)", async () => {
      const result = await runLabelGateSubprocess("gh issue edit 630 --add-label bug")
      expect(
        (result as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput
          ?.permissionDecision
      ).toBe("deny")
    })

    it("blocks --add-label priority-high without /refine-issue (priority label)", async () => {
      const result = await runLabelGateSubprocess("gh issue edit 630 --add-label priority-high")
      expect(
        (result as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput
          ?.permissionDecision
      ).toBe("deny")
    })

    it("blocks mixed readiness+type labels without /refine-issue", async () => {
      const result = await runLabelGateSubprocess(
        "gh issue edit 630 --add-label backlog --add-label bug"
      )
      expect(
        (result as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput
          ?.permissionDecision
      ).toBe("deny")
    })

    it("allows --add-label backlog when /refine-issue was used recently", async () => {
      const result = await runLabelGateSubprocess("gh issue edit 630 --add-label backlog", [
        assistantLine([{ type: "tool_use", name: "Skill", input: { skill: "refine-issue" } }]),
      ])
      expect(
        (result as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput
          ?.permissionDecision
      ).not.toBe("deny")
    })
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

  it("allows Codex git commit after a direct SKILL.md read without requiring TaskList", async () => {
    const result = await runGateSubprocess("commit", {
      tool_name: "functions.exec_command",
      tool_input: { cmd: "git commit -m 'test'" },
      transcript_path: "fake-transcript.json",
      _env: { CODEX_MANAGED_BY_NPM: "1" },
      _transcriptSummary: summaryFromLines([
        assistantLine([
          {
            type: "tool_use",
            name: "functions.exec_command",
            input: { cmd: "cat ~/.../commit/SKILL.md" },
          },
        ]),
      ]),
    })

    expect(
      (result as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput
        ?.permissionDecision
    ).toBe("allow")
  })

  it("blocks Codex git commit when the commit skill was not used recently", async () => {
    const result = await runGateSubprocess("commit", {
      tool_name: "exec_command",
      tool_input: { cmd: "git commit -m 'test'" },
      transcript_path: "fake-transcript.json",
      _env: { CODEX_MANAGED_BY_NPM: "1" },
    })

    expect(
      (result as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput
    ).toMatchObject({ permissionDecision: "deny" })
  })

  it("does not repeat the same missing-skill denial within two minutes", async () => {
    const sessionId = `skill-cooldown-${Date.now()}`
    const payload = {
      tool_name: "Bash",
      tool_input: { command: "git commit -m 'test'" },
      transcript_path: "fake-transcript.json",
      session_id: sessionId,
      _transcriptSummary: summaryFromLines([]),
    }

    const first = await runGateSubprocess("commit", payload)
    const second = await runGateSubprocess("commit", payload)

    expect(
      (first as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput
        ?.permissionDecision
    ).toBe("deny")
    expect(
      (second as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput
        ?.permissionDecision
    ).not.toBe("deny")
  })

  it("repeats the missing-skill denial after the cooldown expires", async () => {
    const sessionId = `skill-cooldown-old-${Date.now()}`
    await Bun.write(
      skillRequirementCooldownPath(sessionId, "claude", "commit"),
      String(Date.now() - 121_000)
    )

    const result = await runGateSubprocess("commit", {
      tool_name: "Bash",
      tool_input: { command: "git commit -m 'test'" },
      transcript_path: "fake-transcript.json",
      session_id: sessionId,
      _transcriptSummary: summaryFromLines([]),
    })

    expect(
      (result as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput
        ?.permissionDecision
    ).toBe("deny")
  })
})
