import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { clearFrameworkCache } from "../src/detect-frameworks.ts"
import { clearSkillCache } from "../src/skill-utils.ts"

const HOOK_ABS = join(import.meta.dir, "pretooluse-require-convert-to-kotlin.ts")

const AGENT_ENV_KEYS = [
  "CLAUDECODE",
  "CURSOR_TRACE_ID",
  "CURSOR_SANDBOX_ENV_RESTORE",
  "GEMINI_CLI",
  "GEMINI_PROJECT_DIR",
  "CODEX_MANAGED_BY_NPM",
  "CODEX_THREAD_ID",
] as const

function makeSummaryForKotlin(sessionLines: string[] = []) {
  return {
    toolNames: [] as string[],
    toolCallCount: 0,
    bashCommands: [] as string[],
    skillInvocations: [] as string[],
    hasGitPush: false,
    sessionLines,
    sessionDurationMs: 0,
    successfulTestRuns: 0,
    lastVerificationTime: null,
    sessionScope: "trivial" as const,
    kotlinSpecific: true,
  }
}

function skillInvocationLine(skillName: string, msAgo = 1000): string {
  return JSON.stringify({
    timestamp: new Date(Date.now() - msAgo).toISOString(),
    type: "assistant",
    message: { content: [{ type: "tool_use", name: "Skill", input: { skill: skillName } }] },
  })
}

// Subprocess helper — needed for CLAUDECODE env isolation (skill detection reads process env)
async function runWithProjectAndSkill(
  filePath: string,
  createIndicatorFiles: string[],
  installSkill: boolean,
  sessionLines: string[] = []
): Promise<Record<string, any>> {
  const projectDir = await mkdtemp(join(tmpdir(), "kotlin-gate-"))
  const fakeHome = await mkdtemp(join(tmpdir(), "kotlin-gate-home-"))
  try {
    for (const indicator of createIndicatorFiles) {
      const parts = indicator.split("/")
      if (parts.length > 1) {
        await mkdir(join(projectDir, ...parts.slice(0, -1)), { recursive: true })
      }
      await writeFile(join(projectDir, indicator), "")
    }

    if (installSkill) {
      const skillDir = join(projectDir, ".skills", "convert-to-kotlin")
      await mkdir(skillDir, { recursive: true })
      await writeFile(join(skillDir, "SKILL.md"), "# convert-to-kotlin\n")
    }

    const env: Record<string, string> = { ...(process.env as Record<string, string>) }
    env.CLAUDECODE = "1"
    env.HOME = fakeHome
    for (const key of AGENT_ENV_KEYS) {
      if (key !== "CLAUDECODE") delete env[key]
    }

    const proc = Bun.spawn(["bun", HOOK_ABS], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      cwd: projectDir,
      env,
    })
    await proc.stdin.write(
      JSON.stringify({
        tool_name: "Edit",
        tool_input: { file_path: filePath },
        transcript_path: "fake.json",
        cwd: projectDir,
        _transcriptSummary: makeSummaryForKotlin(sessionLines),
      })
    )
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
    await rm(fakeHome, { recursive: true, force: true })
  }
}

describe("pretooluse-require-convert-to-kotlin", () => {
  beforeEach(() => {
    clearSkillCache()
    clearFrameworkCache()
  })

  afterEach(() => {
    clearSkillCache()
    clearFrameworkCache()
  })

  it("passes through for non-Java files", async () => {
    // Gradle+Kotlin project, but editing a Kotlin file
    const result = await runWithProjectAndSkill(
      "src/main/kotlin/App.kt",
      ["build.gradle.kts"],
      true,
      []
    )
    expect(result).toEqual({})
  })

  it("passes through for Java files when Gradle and Kotlin are NOT both detected", async () => {
    // Only Gradle detected (no Kotlin indicator), editing Java
    const result = await runWithProjectAndSkill(
      "src/main/java/App.java",
      ["build.gradle"],
      true,
      []
    )
    expect(result).toEqual({})
  })

  it("passes through when Gradle and Kotlin are detected but convert-to-kotlin skill is NOT installed (fail-open)", async () => {
    // Gradle+Kotlin detected, skill not installed
    const result = await runWithProjectAndSkill(
      "src/main/java/App.java",
      ["build.gradle.kts"],
      false,
      []
    )
    expect(result).toEqual({})
  })

  it("blocks Java edits when Gradle and Kotlin are detected, skill is installed, but NOT recently invoked", async () => {
    // Gradle+Kotlin detected, skill installed, but no recent invocation
    const result = await runWithProjectAndSkill(
      "src/main/java/App.java",
      ["build.gradle.kts"],
      true,
      []
    )
    expect(
      (result as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput
        ?.permissionDecision
    ).toBe("deny")
    expect((result as { systemMessage?: string }).systemMessage).toContain("BLOCKED")
    expect((result as { systemMessage?: string }).systemMessage).toContain("convert-to-kotlin")
  })

  it("allows Java edits when Gradle and Kotlin are detected, skill is installed, and WAS recently invoked", async () => {
    // Gradle+Kotlin detected, skill installed, and was recently invoked
    const sessionLines = [skillInvocationLine("convert-to-kotlin")]
    const result = await runWithProjectAndSkill(
      "src/main/java/App.java",
      ["build.gradle.kts"],
      true,
      sessionLines
    )
    expect(
      (result as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput
        ?.permissionDecision
    ).toBe("allow")
    expect((result as { systemMessage?: string }).systemMessage).toContain("was invoked recently")
  })
})
