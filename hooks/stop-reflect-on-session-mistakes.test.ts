import { describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { AGENTS } from "../src/agents.ts"
import { useTempDir } from "../src/utils/test-utils.ts"

const HOOK = "hooks/stop-reflect-on-session-mistakes.ts"

const tmp = useTempDir("swiz-stop-reflect-")

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

async function createReflectSkill(dir: string): Promise<void> {
  const skillDir = join(dir, ".skills", "reflect-on-session-mistakes")
  await mkdir(skillDir, { recursive: true })
  await writeFile(join(skillDir, "SKILL.md"), "# Reflect on session mistakes\n")
}

async function createTranscript(
  dir: string,
  toolName: string,
  skillName?: string
): Promise<string> {
  const transcriptPath = join(dir, "transcript.jsonl")
  const toolUse =
    toolName === "Skill"
      ? {
          type: "tool_use",
          name: "Skill",
          input: { skill: skillName ?? "" },
        }
      : {
          type: "tool_use",
          name: toolName,
          input: toolName === "Bash" ? { command: "echo test" } : {},
        }

  await writeFile(
    transcriptPath,
    `${JSON.stringify({
      type: "assistant",
      message: { content: [toolUse] },
    })}\n`
  )
  return transcriptPath
}

describe("stop-reflect-on-session-mistakes", () => {
  test("blocks stop until the reflect skill has been invoked", async () => {
    const dir = await tmp.create()
    await createReflectSkill(dir)
    const transcriptPath = await createTranscript(dir, "Bash")

    const result = await runHook(dir, transcriptPath)
    expect(result.exitCode).toBe(0)
    expect(result.decision).toBe("block")
    expect(result.reason).toContain("reflect-on-session-mistakes")
  })

  test("allows stop once the reflect skill has been invoked", async () => {
    const dir = await tmp.create()
    await createReflectSkill(dir)
    const transcriptPath = await createTranscript(dir, "Skill", "reflect-on-session-mistakes")

    const result = await runHook(dir, transcriptPath)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe("")
    expect(result.decision).toBeUndefined()
  })
})
