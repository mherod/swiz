import { afterEach, beforeEach, describe, expect, it, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { clearSkillCache } from "../src/skill-utils.ts"
import { runHookInProcess } from "../src/utils/test-utils.ts"
import { isRscGatedFile } from "./pretooluse-apply-rsc-gate.ts"

const HOOK_SCRIPT = "hooks/pretooluse-apply-rsc-gate.ts"
const HOOK_ABS = join(import.meta.dir, "pretooluse-apply-rsc-gate.ts")

const AGENT_ENV_KEYS = [
  "CLAUDECODE",
  "CURSOR_TRACE_ID",
  "CURSOR_SANDBOX_ENV_RESTORE",
  "GEMINI_CLI",
  "GEMINI_PROJECT_DIR",
  "CODEX_MANAGED_BY_NPM",
  "CODEX_THREAD_ID",
] as const

function makeSummary(sessionLines: string[] = []) {
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

function skillInvocationLine(skillName: string, msAgo = 1000): string {
  return JSON.stringify({
    timestamp: new Date(Date.now() - msAgo).toISOString(),
    type: "assistant",
    message: { content: [{ type: "tool_use", name: "Skill", input: { skill: skillName } }] },
  })
}

// Subprocess helper — needed for CLAUDECODE env isolation (skill detection reads process env)
async function runWithSkillInstalled(
  filePath: string,
  sessionLines: string[] = []
): Promise<Record<string, any>> {
  const projectDir = await mkdtemp(join(tmpdir(), "rsc-gate-"))
  try {
    const skillDir = join(projectDir, ".skills", "apply-rsc")
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, "SKILL.md"), "# apply-rsc\n")

    const env: Record<string, string> = { ...(process.env as Record<string, string>) }
    env.CLAUDECODE = "1"
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
        _transcriptSummary: makeSummary(sessionLines),
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
  }
}

// ─── Pure path predicate ────────────────────────────────────────────────────

describe("isRscGatedFile", () => {
  describe("gated paths", () => {
    test("app/page.tsx at root", () => {
      expect(isRscGatedFile("app/page.tsx")).toBe(false) // needs /app/SOMETHING/page.tsx
    })

    test("app/dashboard/page.tsx", () => {
      expect(isRscGatedFile("app/dashboard/page.tsx")).toBe(true)
    })

    test("app/(marketing)/about/page.tsx", () => {
      expect(isRscGatedFile("app/(marketing)/about/page.tsx")).toBe(true)
    })

    test("src/app/settings/page.tsx", () => {
      expect(isRscGatedFile("src/app/settings/page.tsx")).toBe(true)
    })

    test("absolute: /project/app/users/page.tsx", () => {
      expect(isRscGatedFile("/project/app/users/page.tsx")).toBe(true)
    })

    test("layout.tsx at root", () => {
      expect(isRscGatedFile("layout.tsx")).toBe(true)
    })

    test("app/layout.tsx", () => {
      expect(isRscGatedFile("app/layout.tsx")).toBe(true)
    })

    test("src/app/dashboard/layout.tsx", () => {
      expect(isRscGatedFile("src/app/dashboard/layout.tsx")).toBe(true)
    })

    test("deeply nested layout.tsx", () => {
      expect(isRscGatedFile("src/app/(auth)/login/layout.tsx")).toBe(true)
    })

    test("app/dashboard/widget-client.tsx", () => {
      expect(isRscGatedFile("app/dashboard/widget-client.tsx")).toBe(true)
    })

    test("src/app/(marketing)/hero-client.tsx", () => {
      expect(isRscGatedFile("src/app/(marketing)/hero-client.tsx")).toBe(true)
    })

    test("absolute: /project/app/users/avatar-client.tsx", () => {
      expect(isRscGatedFile("/project/app/users/avatar-client.tsx")).toBe(true)
    })
  })

  describe("ungated paths", () => {
    test("page.tsx outside app/", () => {
      expect(isRscGatedFile("src/components/page.tsx")).toBe(false)
    })

    test("app/page.tsx (no sub-segment)", () => {
      expect(isRscGatedFile("app/page.tsx")).toBe(false)
    })

    test("regular component", () => {
      expect(isRscGatedFile("src/components/Button.tsx")).toBe(false)
    })

    test("non-tsx page: app/dashboard/page.ts", () => {
      expect(isRscGatedFile("app/dashboard/page.ts")).toBe(false)
    })

    test("non-tsx layout: layout.ts", () => {
      expect(isRscGatedFile("layout.ts")).toBe(false)
    })

    test("empty path", () => {
      expect(isRscGatedFile("")).toBe(false)
    })

    test("app/api/route.ts", () => {
      expect(isRscGatedFile("app/api/route.ts")).toBe(false)
    })

    test("-client.tsx outside app/", () => {
      expect(isRscGatedFile("src/components/hero-client.tsx")).toBe(false)
    })

    test("client.tsx without -client suffix", () => {
      expect(isRscGatedFile("app/dashboard/client.tsx")).toBe(false)
    })

    test("non-tsx -client file", () => {
      expect(isRscGatedFile("app/dashboard/widget-client.ts")).toBe(false)
    })
  })
})

// ─── In-process pass-through (no skill check needed) ───────────────────────

describe("pretooluse-apply-rsc-gate (in-process)", () => {
  const savedEnv = new Map(AGENT_ENV_KEYS.map((k) => [k, process.env[k]]))

  beforeEach(() => {
    clearSkillCache()
    for (const key of AGENT_ENV_KEYS) delete process.env[key]
  })

  afterEach(() => {
    for (const [k, v] of savedEnv) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    clearSkillCache()
  })

  it("passes through for non-RSC files without reading transcript", async () => {
    const result = await runHookInProcess(HOOK_SCRIPT, {
      tool_name: "Edit",
      tool_input: { file_path: "src/components/Button.tsx" },
      transcript_path: "fake.json",
      _transcriptSummary: makeSummary(),
    })
    expect(result.decision).toBeUndefined()
  })

  it("passes through for page.tsx outside app/", async () => {
    const result = await runHookInProcess(HOOK_SCRIPT, {
      tool_name: "Edit",
      tool_input: { file_path: "src/pages/index/page.tsx" },
      transcript_path: "fake.json",
      _transcriptSummary: makeSummary(),
    })
    expect(result.decision).toBeUndefined()
  })

  it("passes through when skill is not installed (no agent detected)", async () => {
    // No CLAUDECODE env → no agent detected → skillExistsForHookPayload falls back to
    // skillFileExists(). Use a temp HOME so the globally-installed apply-rsc skill is
    // not found, simulating an environment where the skill is absent.
    const fakeHome = await mkdtemp(join(tmpdir(), "rsc-gate-noskill-"))
    const savedHome = process.env.HOME
    process.env.HOME = fakeHome
    clearSkillCache()
    try {
      const result = await runHookInProcess(HOOK_SCRIPT, {
        tool_name: "Edit",
        tool_input: { file_path: "app/dashboard/page.tsx" },
        transcript_path: "fake.json",
        _transcriptSummary: makeSummary(),
      })
      expect(result.decision).toBeUndefined()
    } finally {
      if (savedHome === undefined) delete process.env.HOME
      else process.env.HOME = savedHome
      clearSkillCache()
      await rm(fakeHome, { recursive: true, force: true })
    }
  })

  it("passes through when transcript_path is empty", async () => {
    // No transcript → hook cannot check recency, fails open
    const result = await runHookInProcess(HOOK_SCRIPT, {
      tool_name: "Edit",
      tool_input: { file_path: "app/dashboard/page.tsx" },
      transcript_path: "",
    })
    expect(result.decision).toBeUndefined()
  })
})

// ─── Subprocess tests (env isolation for CLAUDECODE skill detection) ────────

describe("pretooluse-apply-rsc-gate (with skill installed)", () => {
  it("blocks edit to app/**/page.tsx when apply-rsc not recently invoked", async () => {
    // subprocess-only: CLAUDECODE env isolation required for skill detection
    const result = await runWithSkillInstalled("app/dashboard/page.tsx", [])
    expect(
      (result as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput
        ?.permissionDecision
    ).toBe("deny")
    expect((result as { systemMessage?: string }).systemMessage).toContain("BLOCKED")
  })

  it("blocks edit to layout.tsx when apply-rsc not recently invoked", async () => {
    // subprocess-only: CLAUDECODE env isolation required for skill detection
    const result = await runWithSkillInstalled("app/dashboard/layout.tsx", [])
    expect(
      (result as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput
        ?.permissionDecision
    ).toBe("deny")
  })

  it("blocks edit to app/**/*-client.tsx when apply-rsc not recently invoked", async () => {
    // subprocess-only: CLAUDECODE env isolation required for skill detection
    const result = await runWithSkillInstalled("app/dashboard/widget-client.tsx", [])
    expect(
      (result as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput
        ?.permissionDecision
    ).toBe("deny")
  })

  it("allows edit to app/**/page.tsx when apply-rsc was recently invoked", async () => {
    // subprocess-only: CLAUDECODE env isolation required for skill detection
    const sessionLines = [skillInvocationLine("apply-rsc")]
    const result = await runWithSkillInstalled("app/dashboard/page.tsx", sessionLines)
    expect(
      (result as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput
        ?.permissionDecision
    ).toBe("allow")
  })

  it("allows edit to layout.tsx when apply-rsc was recently invoked", async () => {
    // subprocess-only: CLAUDECODE env isolation required for skill detection
    const sessionLines = [skillInvocationLine("apply-rsc")]
    const result = await runWithSkillInstalled("src/app/auth/layout.tsx", sessionLines)
    expect(
      (result as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput
        ?.permissionDecision
    ).toBe("allow")
  })

  it("deny message mentions the skill reference", async () => {
    // subprocess-only: CLAUDECODE env isolation required for skill detection
    const result = await runWithSkillInstalled("app/settings/page.tsx", [])
    expect((result as { systemMessage?: string }).systemMessage).toContain("apply-rsc")
  })

  it("passes through for non-RSC files even when skill installed", async () => {
    // subprocess-only: CLAUDECODE env isolation required for skill detection
    const result = await runWithSkillInstalled("src/components/Button.tsx", [])
    expect(result).toEqual({})
  })
})
