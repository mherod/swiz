import { describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { AGENTS } from "../src/agents.ts"
import { GATE_REQUIRED_SKILLS } from "../src/gate-required-skills.ts"
import { withGitClient } from "../src/git/client.ts"
import { MockGitClient } from "../src/git/mock-client.ts"
import { runHookInProcess as runHookOriginal, useTempDir } from "../src/utils/test-utils.ts"

const HOOK = "hooks/stop-required-skills.ts"

const tmp = useTempDir("swiz-stop-required-skills-")
const repositories = new Map<string, number>()
const mockGit = new MockGitClient((args, { cwd }) => {
  if (!cwd || !repositories.has(cwd)) return { exitCode: 1 }
  if (args[0] === "rev-parse" && args.includes("--show-toplevel")) return cwd
  if (args[0] === "rev-parse" && args.includes("--git-dir")) return ".git"
  if (args[0] === "rev-parse" && args.includes("--is-inside-work-tree")) return "true"
  if (args[0] === "rev-parse" && args.includes("@{upstream}")) {
    return repositories.get(cwd) ? "origin/main" : { exitCode: 1 }
  }
  if (args[0] === "rev-list") return String(repositories.get(cwd))
  if (args[0] === "rev-parse" && args[1] === "HEAD") return "local"
  return { exitCode: 1 }
})
function runHookInProcess(...args: Parameters<typeof runHookOriginal>) {
  return withGitClient(mockGit, () => runHookOriginal(...args))
}

interface HookResult {
  exitCode: number | null
  stdout: string
  stderr: string
  decision?: string
  reason?: string
}

async function runHookWithInput(
  cwd: string,
  transcriptPath: string,
  extraInput: Record<string, unknown> = {}
): Promise<HookResult> {
  const env: Record<string, string | undefined> = {}
  env.HOME = cwd
  for (const agent of AGENTS) {
    for (const v of agent.envVars ?? []) env[v] = ""
  }
  // CLAUDECODE is required for Skill tool support detection in skill-utils.ts
  env.CLAUDECODE = "1"
  // Unset other agent vars to ensure detectCurrentAgent() picks Claude
  env.ANTHROPIC_EXEC_VERSION = "1.0.0"

  return await runHookInProcess(
    HOOK,
    {
      cwd,
      session_id: "test-session",
      transcript_path: transcriptPath,
      ...extraInput,
      _effectiveSettings: {
        autoContinue: true,
        ...((extraInput._effectiveSettings as Record<string, unknown>) ?? {}),
      },
    },
    { cwd, env }
  )
}

async function runHook(cwd: string, transcriptPath: string): Promise<HookResult> {
  return await runHookWithInput(cwd, transcriptPath)
}

function initGitRepo(dir: string): void {
  repositories.set(dir, 0)
}

async function createSkill(dir: string, name: string, heading: string): Promise<void> {
  const skillDir = join(dir, ".skills", name)
  await mkdir(skillDir, { recursive: true })
  await writeFile(join(skillDir, "SKILL.md"), `# ${heading}\n`)
}

async function createTranscript(dir: string, skills: string[] = []): Promise<string> {
  const transcriptPath = join(dir, "transcript.jsonl")
  const now = Date.now()
  const content =
    skills.length > 0
      ? skills.map((skill) => ({
          type: "tool_use",
          name: "Skill",
          input: { skill },
        }))
      : [
          {
            type: "tool_use",
            name: "Bash",
            input: { command: "echo test" },
          },
        ]
  await writeFile(
    transcriptPath,
    `${JSON.stringify({
      timestamp: new Date(now - 1000).toISOString(),
      type: "assistant",
      message: { content },
    })}\n`
  )
  return transcriptPath
}

async function createOldTranscript(dir: string, skills: string[]): Promise<string> {
  const transcriptPath = join(dir, "old-transcript.jsonl")
  const old = Date.now() - 21 * 60 * 1000
  await writeFile(
    transcriptPath,
    `${JSON.stringify({
      timestamp: new Date(old).toISOString(),
      type: "assistant",
      message: {
        content: skills.map((skill) => ({
          type: "tool_use",
          name: "Skill",
          input: { skill },
        })),
      },
    })}\n`
  )
  return transcriptPath
}

const ALL_REQUIRED_SKILLS = [
  GATE_REQUIRED_SKILLS.endOfDay.name,
  GATE_REQUIRED_SKILLS.farmOutIssues.name,
  GATE_REQUIRED_SKILLS.continueWithTasks.name,
  GATE_REQUIRED_SKILLS.reflectOnSessionMistakes.name,
]

describe("stop-required-skills", () => {
  test("does not require backlog delegation without continuation opt-in", async () => {
    const dir = await tmp.create()
    await initGitRepo(dir)
    for (const s of ALL_REQUIRED_SKILLS) await createSkill(dir, s, s)
    const transcriptPath = await createTranscript(dir, ["reflect-on-session-mistakes"])
    const result = await runHookWithInput(dir, transcriptPath, {
      _effectiveSettings: { autoContinue: false },
    })
    expect(result.decision).toBeUndefined()
  })
  test("blocks on the first missing required skill by priority", async () => {
    const dir = await tmp.create()
    await initGitRepo(dir)
    for (const s of ALL_REQUIRED_SKILLS) await createSkill(dir, s, s)
    const transcriptPath = await createTranscript(dir)

    const result = await runHook(dir, transcriptPath)
    expect(result.exitCode).toBe(0)
    expect(result.decision).toBe("block")
    expect(result.reason).toContain("farm-out-issues")
    expect(result.reason).toContain(
      join(dir, ".skills", GATE_REQUIRED_SKILLS.farmOutIssues.name, "SKILL.md")
    )
  })

  test("falls through to the next missing skill once higher-priority skills were used", async () => {
    const dir = await tmp.create()
    await initGitRepo(dir)
    for (const s of ALL_REQUIRED_SKILLS) await createSkill(dir, s, s)
    // end-of-day is used
    const transcriptPath = await createTranscript(dir, ["end-of-day"])

    const result = await runHook(dir, transcriptPath)
    expect(result.exitCode).toBe(0)
    expect(result.decision).toBe("block")
    expect(result.reason).toContain("farm-out-issues")
  })

  test("reaches reflection only after the higher-priority skills were used", async () => {
    const dir = await tmp.create()
    for (const s of ALL_REQUIRED_SKILLS) await createSkill(dir, s, s)
    const transcriptPath = await createTranscript(dir, [
      "end-of-day",
      "farm-out-issues",
      "continue-with-tasks",
    ])

    const result = await runHook(dir, transcriptPath)
    expect(result.exitCode).toBe(0)
    expect(result.decision).toBe("block")
    expect(result.reason).toContain("reflect-on-session-mistakes")
  })

  test("allows stop once all applicable required skills were used", async () => {
    const dir = await tmp.create()
    for (const s of ALL_REQUIRED_SKILLS) await createSkill(dir, s, s)
    const transcriptPath = await createTranscript(dir, ALL_REQUIRED_SKILLS)

    const result = await runHook(dir, transcriptPath)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe("")
    expect(result.decision).toBeUndefined()
  })

  test("does not repeat completed skill checks solely because twenty minutes elapsed", async () => {
    const dir = await tmp.create()
    await initGitRepo(dir)
    for (const s of ALL_REQUIRED_SKILLS) await createSkill(dir, s, s)
    const transcriptPath = await createOldTranscript(dir, ALL_REQUIRED_SKILLS)

    const result = await runHook(dir, transcriptPath)
    expect(result.exitCode).toBe(0)
    expect(result.decision).toBeUndefined()
  })

  function initGitRepoWithUnpushedCommit(dir: string): void {
    repositories.set(dir, 1)
  }

  describe("end-of-day rule", () => {
    test("skips when repo has no upstream — falls through to next rule", async () => {
      const dir = await tmp.create()
      await initGitRepo(dir) // no remote, no upstream
      for (const s of ALL_REQUIRED_SKILLS) await createSkill(dir, s, s)
      const transcriptPath = await createTranscript(dir)

      const result = await runHook(dir, transcriptPath)
      expect(result.exitCode).toBe(0)
      expect(result.decision).toBe("block")
      // Should hit farm-out-issues instead of end-of-day
      expect(result.reason).toContain("farm-out-issues")
    })

    test("blocks when unpushed commits exist and end-of-day was not used", async () => {
      const dir = await tmp.create()
      await initGitRepoWithUnpushedCommit(dir)
      for (const s of ALL_REQUIRED_SKILLS) await createSkill(dir, s, s)
      const transcriptPath = await createTranscript(dir, [
        "farm-out-issues",
        "continue-with-tasks",
        "reflect-on-session-mistakes",
      ])

      const result = await runHook(dir, transcriptPath)
      expect(result.exitCode).toBe(0)
      expect(result.decision).toBe("block")
      expect(result.reason).toContain("end-of-day")
      expect(result.reason).toContain("Local commits unpushed")
    })

    test("blocks when incomplete tasks exist and end-of-day was not used", async () => {
      const dir = await tmp.create()
      await initGitRepo(dir) // No unpushed commits
      for (const s of ALL_REQUIRED_SKILLS) await createSkill(dir, s, s)
      const transcriptPath = await createTranscript(dir, [
        "farm-out-issues",
        "continue-with-tasks",
        "reflect-on-session-mistakes",
      ])

      // Create an incomplete task
      const tasksDir = join(dir, ".claude/tasks/test-session")
      await mkdir(tasksDir, { recursive: true })
      await writeFile(
        join(tasksDir, "T1.json"),
        `${JSON.stringify({
          id: "T1",
          status: "pending",
          subject: "Incomplete task",
          description: "...",
        })}\n`
      )

      const result = await runHook(dir, transcriptPath)
      expect(result.exitCode).toBe(0)
      expect(result.decision).toBe("block")
      expect(result.reason).toContain("end-of-day")
      expect(result.reason).toContain("Session shortlist incomplete")
    })

    test("allows stop when all required skills were used including end-of-day", async () => {
      const dir = await tmp.create()
      await initGitRepoWithUnpushedCommit(dir)
      for (const s of ALL_REQUIRED_SKILLS) await createSkill(dir, s, s)
      const transcriptPath = await createTranscript(dir, [...ALL_REQUIRED_SKILLS])

      const result = await runHook(dir, transcriptPath)
      expect(result.exitCode).toBe(0)
    })

    test("skips when enforceEndOfDay is false in effective settings", async () => {
      const dir = await tmp.create()
      await initGitRepoWithUnpushedCommit(dir)
      for (const s of ALL_REQUIRED_SKILLS) await createSkill(dir, s, s)
      // transcript has all required skills EXCEPT end-of-day; enforceEndOfDay:false causes that rule to skip
      const transcriptPath = await createTranscript(dir, [
        "farm-out-issues",
        "continue-with-tasks",
        "reflect-on-session-mistakes",
      ])

      const result = await runHookWithInput(dir, transcriptPath, {
        _effectiveSettings: { enforceEndOfDay: false },
      })
      // Should skip end-of-day, and since all others are present, it should ALLOW
      expect(result.exitCode).toBe(0)
    })
  })

  test("blocks Codex with its preferred verified SKILL.md path", async () => {
    const dir = await tmp.create()
    await initGitRepo(dir)
    for (const s of ALL_REQUIRED_SKILLS) await createSkill(dir, s, s)
    const skill = GATE_REQUIRED_SKILLS.farmOutIssues.name
    const claudePath = join(dir, ".claude", "skills", skill, "SKILL.md")
    const codexPath = join(dir, ".codex", "skills", skill, "SKILL.md")
    await mkdir(join(dir, ".claude", "skills", skill), { recursive: true })
    await mkdir(join(dir, ".codex", "skills", skill), { recursive: true })
    await writeFile(claudePath, "# Claude farm out\n")
    await writeFile(codexPath, "# Codex farm out\n")
    const transcriptPath = await createTranscript(dir) // no skills invoked

    const result = await runHookWithInput(dir, transcriptPath, {
      _env: { CODEX_MANAGED_BY_NPM: "1" },
    })

    expect(result.exitCode).toBe(0)
    expect(result.decision).toBe("block")
    expect(result.reason).toContain(codexPath)
    expect(result.reason).not.toContain(claudePath)
  })

  test("includes compaction note when required skill was used only before a compaction boundary", async () => {
    const dir = await tmp.create()
    await initGitRepo(dir)
    for (const s of ALL_REQUIRED_SKILLS) await createSkill(dir, s, s)

    // Transcript: skill before compaction, system boundary, then unrelated post-compaction content.
    const transcriptPath = join(dir, "compact-transcript.jsonl")
    const now = Date.now()
    await writeFile(
      transcriptPath,
      `${[
        JSON.stringify({
          timestamp: new Date(now - 5000).toISOString(),
          type: "assistant",
          message: {
            content: [{ type: "tool_use", name: "Skill", input: { skill: "farm-out-issues" } }],
          },
        }),
        JSON.stringify({ type: "system", subtype: "compact" }),
        JSON.stringify({
          timestamp: new Date(now - 1000).toISOString(),
          type: "assistant",
          message: {
            content: [{ type: "tool_use", name: "Bash", input: { command: "echo test" } }],
          },
        }),
      ].join("\n")}\n`
    )

    const result = await runHook(dir, transcriptPath)
    expect(result.exitCode).toBe(0)
    expect(result.decision).toBe("block")
    expect(result.reason).toContain("farm-out-issues")
    expect(result.reason).toContain("compaction reset the recency window")
  })

  describe("farm-out-issues bypass rule", () => {
    async function createFarmOutOldThenBash(dir: string, bashCommand: string): Promise<string> {
      const transcriptPath = join(dir, "farm-out-old.jsonl")
      const old = Date.now() - 25 * 60 * 1000
      const recent = Date.now() - 1000
      await writeFile(
        transcriptPath,
        `${[
          JSON.stringify({
            timestamp: new Date(old).toISOString(),
            type: "assistant",
            message: {
              content: [{ type: "tool_use", name: "Skill", input: { skill: "farm-out-issues" } }],
            },
          }),
          JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "ok" }] } }),
          JSON.stringify({
            timestamp: new Date(recent).toISOString(),
            type: "assistant",
            message: {
              content: [{ type: "tool_use", name: "Bash", input: { command: bashCommand } }],
            },
          }),
        ].join("\n")}\n`
      )
      return transcriptPath
    }

    test("bypasses farm-out-issues gate when no git commits happened since last invocation", async () => {
      const dir = await tmp.create()
      await initGitRepo(dir)
      for (const s of ALL_REQUIRED_SKILLS) await createSkill(dir, s, s)
      const transcriptPath = await createFarmOutOldThenBash(dir, "bun test --reporter=dots")

      const result = await runHook(dir, transcriptPath)
      expect(result.exitCode).toBe(0)
      expect(result.decision).toBe("block")
      // farm-out-issues bypassed; next rule fires
      expect(result.reason).not.toContain("farm-out-issues")
      expect(result.reason).toContain("reflect-on-session-mistakes")
    })

    test("does not bypass farm-out-issues gate when a git push happened after last invocation", async () => {
      const dir = await tmp.create()
      await initGitRepo(dir)
      for (const s of ALL_REQUIRED_SKILLS) await createSkill(dir, s, s)
      const transcriptPath = await createFarmOutOldThenBash(dir, "git push origin main")

      const result = await runHook(dir, transcriptPath)
      expect(result.exitCode).toBe(0)
      expect(result.decision).toBe("block")
      expect(result.reason).toContain("farm-out-issues")
    })

    test("does not bypass farm-out-issues gate when a git commit happened after last invocation", async () => {
      const dir = await tmp.create()
      await initGitRepo(dir)
      for (const s of ALL_REQUIRED_SKILLS) await createSkill(dir, s, s)
      const transcriptPath = await createFarmOutOldThenBash(dir, "git commit -m feat: add feature")

      const result = await runHook(dir, transcriptPath)
      expect(result.exitCode).toBe(0)
      expect(result.decision).toBe("block")
      expect(result.reason).toContain("farm-out-issues")
    })
  })

  test("fails open when no required SKILL.md file exists", async () => {
    const dir = await tmp.create()
    const transcriptPath = await createTranscript(dir)

    const result = await runHookInProcess(
      HOOK,
      {
        cwd: dir,
        session_id: "test-session",
        transcript_path: transcriptPath,
      },
      {
        cwd: dir,
        env: {
          HOME: dir,
          CLAUDECODE: undefined,
          ANTHROPIC_EXEC_VERSION: undefined,
        },
      }
    )

    expect(result.exitCode).toBe(0)
    expect(result.decision).toBeUndefined()
  })
})
