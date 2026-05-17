import { describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { AGENTS } from "../src/agents.ts"
import { useTempDir } from "../src/utils/test-utils.ts"

const HOOK = join(import.meta.dir, "stop-required-skills.ts")

const tmp = useTempDir("swiz-stop-required-skills-")

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
  const env: Record<string, string | undefined> = { ...process.env }
  env.HOME = cwd
  for (const agent of AGENTS) {
    for (const v of agent.envVars ?? []) env[v] = ""
  }
  // CLAUDECODE is required for Skill tool support detection in skill-utils.ts
  env.CLAUDECODE = "1"
  env.DEBUG_SKILLS = "1"
  env.DEBUG_REQUIRED_SKILLS = "1"
  // Unset other agent vars to ensure detectCurrentAgent() picks Claude
  env.ANTHROPIC_EXEC_VERSION = "1.0.0"

  const proc = Bun.spawn(["bun", HOOK], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    cwd,
    env: env as Record<string, string>,
  })
  await proc.stdin.write(
    JSON.stringify({
      cwd,
      session_id: "test-session",
      transcript_path: transcriptPath,
      ...extraInput,
    })
  )
  await proc.stdin.end()

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited

  let decision: string | undefined
  let reason: string | undefined
  const trimmed = stdout.trim()
  if (trimmed) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, any>
      decision = parsed.decision as string | undefined
      reason = parsed.reason as string | undefined
    } catch {}
  }

  return { exitCode: proc.exitCode, stdout: trimmed, stderr, decision, reason }
}

async function runHook(cwd: string, transcriptPath: string): Promise<HookResult> {
  return await runHookWithInput(cwd, transcriptPath)
}

async function initGitRepo(dir: string): Promise<void> {
  const proc = Bun.spawn(["git", "init"], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  })
  await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  await proc.exited
  const branchProc = Bun.spawn(["git", "branch", "-M", "main"], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  })
  await Promise.all([
    new Response(branchProc.stdout).text(),
    new Response(branchProc.stderr).text(),
  ])
  await branchProc.exited
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
  "end-of-day",
  "farm-out-issues",
  "continue-with-tasks",
  "reflect-on-session-mistakes",
]

describe("stop-required-skills", () => {
  test("blocks on the first missing required skill by priority", async () => {
    const dir = await tmp.create()
    await initGitRepo(dir)
    for (const s of ALL_REQUIRED_SKILLS) await createSkill(dir, s, s)
    const transcriptPath = await createTranscript(dir)

    const result = await runHook(dir, transcriptPath)
    expect(result.exitCode).toBe(0)
    expect(result.decision).toBe("block")
    expect(result.reason).toContain("farm-out-issues")
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

  test("treats required skills older than twenty minutes as missing", async () => {
    const dir = await tmp.create()
    await initGitRepo(dir)
    for (const s of ALL_REQUIRED_SKILLS) await createSkill(dir, s, s)
    const transcriptPath = await createOldTranscript(dir, ALL_REQUIRED_SKILLS)

    const result = await runHook(dir, transcriptPath)
    expect(result.exitCode).toBe(0)
    expect(result.decision).toBe("block")
    expect(result.reason).toContain("farm-out-issues")
    expect(result.reason).toContain("last 30 turns and last 20 minutes")
  })

  async function runGitCmd(cwd: string, args: string[]): Promise<void> {
    const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
    await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    await proc.exited
  }

  async function initGitRepoWithUnpushedCommit(dir: string): Promise<void> {
    await initGitRepo(dir)
    await runGitCmd(dir, ["config", "user.email", "you@example.com"])
    await runGitCmd(dir, ["config", "user.name", "Your Name"])
    await runGitCmd(dir, ["commit", "--allow-empty", "-m", "initial"])

    // Add a remote and an upstream branch
    const remoteDir = await tmp.create()
    const proc = Bun.spawn(["git", "init", "--bare"], {
      cwd: remoteDir,
      stdout: "pipe",
      stderr: "pipe",
    })
    await proc.exited
    await runGitCmd(dir, ["remote", "add", "origin", remoteDir])
    await runGitCmd(dir, ["push", "-u", "origin", "HEAD:main"])
    await runGitCmd(dir, ["branch", "--set-upstream-to=origin/main", "main"])

    // Add one unpushed commit
    await runGitCmd(dir, ["commit", "--allow-empty", "-m", "unpushed"])
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

  test("skips all skill requirements when payload _env identifies a Codex session", async () => {
    // Daemon process has CLAUDECODE (would normally trigger skill gates) but the
    // dispatched payload carries _env from a Codex session.  Codex has no Skill
    // tool so all skill requirements should be bypassed — the hook must allow.
    const dir = await tmp.create()
    await initGitRepo(dir)
    for (const s of ALL_REQUIRED_SKILLS) await createSkill(dir, s, s)
    const transcriptPath = await createTranscript(dir) // no skills invoked

    const result = await runHookWithInput(dir, transcriptPath, {
      _env: { CODEX_MANAGED_BY_NPM: "1" },
    })

    expect(result.exitCode).toBe(0)
    expect(result.decision).toBeUndefined()
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
      [
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
      ].join("\n") + "\n"
    )

    const result = await runHook(dir, transcriptPath)
    expect(result.exitCode).toBe(0)
    expect(result.decision).toBe("block")
    expect(result.reason).toContain("farm-out-issues")
    expect(result.reason).toContain("compaction reset the recency window")
  })

  test("fails open when the active agent does not support the Skill tool", async () => {
    const dir = await tmp.create()
    const transcriptPath = await createTranscript(dir)

    // Run without CLAUDECODE env
    const proc = Bun.spawn(["bun", HOOK], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      cwd: dir,
      env: { ...process.env, CLAUDECODE: "" },
    })
    await proc.stdin.write(
      JSON.stringify({
        cwd: dir,
        session_id: "test-session",
        transcript_path: transcriptPath,
      })
    )
    await proc.stdin.end()
    await proc.exited

    expect(proc.exitCode).toBe(0)
  })
})
