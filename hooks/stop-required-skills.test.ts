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

async function runHook(cwd: string, transcriptPath: string): Promise<HookResult> {
  const env: Record<string, string | undefined> = { ...process.env }
  for (const agent of AGENTS) {
    for (const v of agent.envVars ?? []) env[v] = ""
  }
  env.CLAUDECODE = "1"

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

async function initGitRepo(dir: string): Promise<void> {
  const proc = Bun.spawn(["git", "init"], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  })
  await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  await proc.exited
}

async function createSkill(dir: string, name: string, heading: string): Promise<void> {
  const skillDir = join(dir, ".skills", name)
  await mkdir(skillDir, { recursive: true })
  await writeFile(join(skillDir, "SKILL.md"), `# ${heading}\n`)
}

async function createTranscript(dir: string, skills: string[] = []): Promise<string> {
  const transcriptPath = join(dir, "transcript.jsonl")
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
      type: "assistant",
      message: { content },
    })}\n`
  )
  return transcriptPath
}

describe("stop-required-skills", () => {
  test("blocks on the first missing required skill by priority", async () => {
    const dir = await tmp.create()
    await initGitRepo(dir)
    await createSkill(dir, "farm-out-issues", "Farm out issues")
    await createSkill(dir, "continue-with-tasks", "Continue with tasks")
    await createSkill(dir, "reflect-on-session-mistakes", "Reflect on session mistakes")
    const transcriptPath = await createTranscript(dir)

    const result = await runHook(dir, transcriptPath)
    expect(result.exitCode).toBe(0)
    expect(result.decision).toBe("block")
    expect(result.reason).toContain("farm-out-issues")
    expect(result.reason).not.toContain("reflect-on-session-mistakes skill to be used first")
  })

  test("falls through to the next missing skill once higher-priority skills were used", async () => {
    const dir = await tmp.create()
    await initGitRepo(dir)
    await createSkill(dir, "farm-out-issues", "Farm out issues")
    await createSkill(dir, "continue-with-tasks", "Continue with tasks")
    await createSkill(dir, "reflect-on-session-mistakes", "Reflect on session mistakes")
    const transcriptPath = await createTranscript(dir, ["farm-out-issues"])

    const result = await runHook(dir, transcriptPath)
    expect(result.exitCode).toBe(0)
    expect(result.decision).toBe("block")
    expect(result.reason).toContain("continue-with-tasks")
  })

  test("reaches reflection only after the higher-priority skills were used", async () => {
    const dir = await tmp.create()
    await initGitRepo(dir)
    await createSkill(dir, "farm-out-issues", "Farm out issues")
    await createSkill(dir, "continue-with-tasks", "Continue with tasks")
    await createSkill(dir, "reflect-on-session-mistakes", "Reflect on session mistakes")
    const transcriptPath = await createTranscript(dir, ["farm-out-issues", "continue-with-tasks"])

    const result = await runHook(dir, transcriptPath)
    expect(result.exitCode).toBe(0)
    expect(result.decision).toBe("block")
    expect(result.reason).toContain("reflect-on-session-mistakes")
  })

  test("allows stop once all applicable required skills were used", async () => {
    const dir = await tmp.create()
    await initGitRepo(dir)
    await createSkill(dir, "farm-out-issues", "Farm out issues")
    await createSkill(dir, "continue-with-tasks", "Continue with tasks")
    await createSkill(dir, "reflect-on-session-mistakes", "Reflect on session mistakes")
    const transcriptPath = await createTranscript(dir, [
      "farm-out-issues",
      "continue-with-tasks",
      "reflect-on-session-mistakes",
    ])

    const result = await runHook(dir, transcriptPath)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe("")
    expect(result.decision).toBeUndefined()
  })

  test("fails open when the active agent does not support the Skill tool", async () => {
    const dir = await tmp.create()
    await initGitRepo(dir)
    const transcriptPath = await createTranscript(dir)

    const env: Record<string, string | undefined> = { ...process.env }
    for (const agent of AGENTS) {
      for (const v of agent.envVars ?? []) env[v] = ""
    }

    const proc = Bun.spawn(["bun", HOOK], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      cwd: dir,
      env: env as Record<string, string>,
    })
    await proc.stdin.write(
      JSON.stringify({
        cwd: dir,
        session_id: "test-session",
        transcript_path: transcriptPath,
      })
    )
    await proc.stdin.end()
    const [stdout] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    await proc.exited

    expect(proc.exitCode).toBe(0)
    expect(stdout.trim()).toBe("")
  })
})
