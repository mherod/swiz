import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  DEFAULT_TRIVIAL_MAX_FILES,
  DEFAULT_TRIVIAL_MAX_LINES,
  POLICY_PROFILES,
  readProjectSettings,
  resolvePolicy,
} from "../settings.ts"
import { projectKeyFromCwd } from "../transcript-utils.ts"

const tempDirs: string[] = []

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (!dir) continue
    await rm(dir, { recursive: true, force: true })
  }
})

async function createTempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "swiz-settings-test-"))
  tempDirs.push(dir)
  return dir
}

async function runSwiz(
  args: string[],
  home: string
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const proc = Bun.spawn(["bun", "run", "index.ts", ...args], {
    cwd: process.cwd(),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HOME: home },
  })
  proc.stdin.end()
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  await proc.exited
  return { stdout, stderr, exitCode: proc.exitCode }
}

async function createSession(home: string, targetDir: string, sessionId: string): Promise<void> {
  const projectKey = projectKeyFromCwd(targetDir)
  const projectDir = join(home, ".claude", "projects", projectKey)
  await mkdir(projectDir, { recursive: true })
  await writeFile(
    join(projectDir, `${sessionId}.jsonl`),
    `{"type":"user","message":{"content":"test"},"cwd":"${targetDir}"}\n`
  )
}

describe("swiz settings", () => {
  test("shows default auto-continue state when no config exists", async () => {
    const home = await createTempHome()
    const result = await runSwiz(["settings"], home)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("auto-continue:   enabled")
    expect(result.stdout).toContain("(defaults)")
  })

  test("disables auto-continue and persists to user config", async () => {
    const home = await createTempHome()
    const result = await runSwiz(["settings", "disable", "auto-continue"], home)
    expect(result.exitCode).toBe(0)

    const configPath = join(home, ".swiz", "settings.json")
    const text = await readFile(configPath, "utf-8")
    const json = JSON.parse(text) as { autoContinue?: boolean }
    expect(json.autoContinue).toBe(false)
  })

  test("enables auto-continue after being disabled", async () => {
    const home = await createTempHome()
    const disableResult = await runSwiz(["settings", "disable", "auto-continue"], home)
    expect(disableResult.exitCode).toBe(0)

    const enableResult = await runSwiz(["settings", "enable", "auto-continue"], home)
    expect(enableResult.exitCode).toBe(0)

    const configPath = join(home, ".swiz", "settings.json")
    const text = await readFile(configPath, "utf-8")
    const json = JSON.parse(text) as { autoContinue?: boolean }
    expect(json.autoContinue).toBe(true)
  })

  test("fails for unknown setting key", async () => {
    const home = await createTempHome()
    const result = await runSwiz(["settings", "disable", "unknown-flag"], home)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("Unknown setting")
    expect(result.stderr).toContain("auto-continue")
  })

  test("new sessions inherit the global setting by default", async () => {
    const home = await createTempHome()
    const targetDir = join(home, "repo")
    const sessionId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
    await createSession(home, targetDir, sessionId)

    const disableGlobal = await runSwiz(["settings", "disable", "auto-continue"], home)
    expect(disableGlobal.exitCode).toBe(0)

    const showSession = await runSwiz(
      ["settings", "show", "--session", sessionId.slice(0, 8), "--dir", targetDir],
      home
    )
    expect(showSession.exitCode).toBe(0)
    expect(showSession.stdout).toContain(`scope: session ${sessionId}`)
    expect(showSession.stdout).toContain("auto-continue:   disabled (global/default)")
  })

  test("session-scoped disable stores override under sessions map", async () => {
    const home = await createTempHome()
    const targetDir = join(home, "repo")
    const sessionId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
    await createSession(home, targetDir, sessionId)

    const result = await runSwiz(
      ["settings", "disable", "auto-continue", "--session", "--dir", targetDir],
      home
    )
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain(`for session ${sessionId}`)

    const configPath = join(home, ".swiz", "settings.json")
    const text = await readFile(configPath, "utf-8")
    const json = JSON.parse(text) as {
      autoContinue?: boolean
      sessions?: Record<string, { autoContinue?: boolean }>
    }

    expect(json.autoContinue).toBe(true)
    expect(json.sessions?.[sessionId]?.autoContinue).toBe(false)
  })

  test("fails when session prefix does not match an existing session", async () => {
    const home = await createTempHome()
    const targetDir = join(home, "repo")
    await createSession(home, targetDir, "cccccccc-cccc-cccc-cccc-cccccccccccc")

    const result = await runSwiz(
      ["settings", "disable", "auto-continue", "--session", "not-found", "--dir", targetDir],
      home
    )
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("No session matching")
  })

  test("shows default narrator-voice and narrator-speed as system default", async () => {
    const home = await createTempHome()
    const result = await runSwiz(["settings"], home)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("narrator-voice:  system default")
    expect(result.stdout).toContain("narrator-speed:  system default")
  })

  test("sets narrator-voice and persists to config", async () => {
    const home = await createTempHome()
    const result = await runSwiz(["settings", "set", "narrator-voice", "Samantha"], home)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("Set narrator-voice = Samantha")

    const configPath = join(home, ".swiz", "settings.json")
    const text = await readFile(configPath, "utf-8")
    const json = JSON.parse(text) as { narratorVoice?: string }
    expect(json.narratorVoice).toBe("Samantha")
  })

  test("sets narrator-speed and persists to config", async () => {
    const home = await createTempHome()
    const result = await runSwiz(["settings", "set", "narrator-speed", "250"], home)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("Set narrator-speed = 250")

    const configPath = join(home, ".swiz", "settings.json")
    const text = await readFile(configPath, "utf-8")
    const json = JSON.parse(text) as { narratorSpeed?: number }
    expect(json.narratorSpeed).toBe(250)
  })

  test("shows configured narrator-voice in settings output", async () => {
    const home = await createTempHome()
    await runSwiz(["settings", "set", "narrator-voice", "Alex"], home)
    const result = await runSwiz(["settings"], home)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("narrator-voice:  Alex")
  })

  test("shows configured narrator-speed in settings output", async () => {
    const home = await createTempHome()
    await runSwiz(["settings", "set", "narrator-speed", "180"], home)
    const result = await runSwiz(["settings"], home)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("narrator-speed:  180 wpm")
  })

  test("rejects enable/disable for narrator-voice", async () => {
    const home = await createTempHome()
    const result = await runSwiz(["settings", "enable", "narrator-voice"], home)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("not a boolean setting")
  })

  test("existing settings files load cleanly without narrator fields", async () => {
    const home = await createTempHome()
    const configDir = join(home, ".swiz")
    await mkdir(configDir, { recursive: true })
    // Write a settings file without narratorVoice/narratorSpeed (backward compat)
    await writeFile(
      join(configDir, "settings.json"),
      JSON.stringify({ autoContinue: false, speak: true })
    )
    const result = await runSwiz(["settings"], home)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("auto-continue:   disabled")
    expect(result.stdout).toContain("speak:           enabled")
    expect(result.stdout).toContain("narrator-voice:  system default")
    expect(result.stdout).toContain("narrator-speed:  system default")
  })

  test("shows project policy section in settings output", async () => {
    const home = await createTempHome()
    const projectDir = await mkdtemp(join(tmpdir(), "swiz-policy-test-"))
    tempDirs.push(projectDir)
    const swizDir = join(projectDir, ".swiz")
    await mkdir(swizDir, { recursive: true })
    await writeFile(join(swizDir, "config.json"), JSON.stringify({ profile: "strict" }))

    const result = await runSwiz(["settings", "--dir", projectDir], home)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("project policy")
    expect(result.stdout).toContain("profile:         strict")
    expect(result.stdout).toContain("trivial-max-files: 1")
    expect(result.stdout).toContain("trivial-max-lines: 10")
  })

  test("shows default project policy when no config.json present", async () => {
    const home = await createTempHome()
    const result = await runSwiz(["settings"], home)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("project policy")
    expect(result.stdout).toContain(`trivial-max-files: ${DEFAULT_TRIVIAL_MAX_FILES}`)
    expect(result.stdout).toContain(`trivial-max-lines: ${DEFAULT_TRIVIAL_MAX_LINES}`)
    expect(result.stdout).toContain("(default)")
  })
})

// ─── resolvePolicy unit tests ───────────────────────────────────────────────

describe("resolvePolicy", () => {
  test("returns defaults when no project settings", () => {
    const policy = resolvePolicy(null)
    expect(policy.trivialMaxFiles).toBe(DEFAULT_TRIVIAL_MAX_FILES)
    expect(policy.trivialMaxLines).toBe(DEFAULT_TRIVIAL_MAX_LINES)
    expect(policy.profile).toBeNull()
    expect(policy.source).toBe("default")
  })

  test("applies solo profile preset", () => {
    const policy = resolvePolicy({ profile: "solo" })
    expect(policy.trivialMaxFiles).toBe(POLICY_PROFILES.solo.trivialMaxFiles)
    expect(policy.trivialMaxLines).toBe(POLICY_PROFILES.solo.trivialMaxLines)
    expect(policy.profile).toBe("solo")
    expect(policy.source).toBe("project")
  })

  test("applies team profile preset", () => {
    const policy = resolvePolicy({ profile: "team" })
    expect(policy.trivialMaxFiles).toBe(POLICY_PROFILES.team.trivialMaxFiles)
    expect(policy.trivialMaxLines).toBe(POLICY_PROFILES.team.trivialMaxLines)
    expect(policy.profile).toBe("team")
    expect(policy.source).toBe("project")
  })

  test("applies strict profile preset", () => {
    const policy = resolvePolicy({ profile: "strict" })
    expect(policy.trivialMaxFiles).toBe(POLICY_PROFILES.strict.trivialMaxFiles)
    expect(policy.trivialMaxLines).toBe(POLICY_PROFILES.strict.trivialMaxLines)
    expect(policy.profile).toBe("strict")
    expect(policy.source).toBe("project")
  })

  test("per-field override takes precedence over profile", () => {
    // Start with solo (permissive), but override files count to be strict
    const policy = resolvePolicy({ profile: "solo", trivialMaxFiles: 2 })
    expect(policy.trivialMaxFiles).toBe(2)
    // Lines still come from the solo profile
    expect(policy.trivialMaxLines).toBe(POLICY_PROFILES.solo.trivialMaxLines)
    expect(policy.profile).toBe("solo")
  })

  test("per-field overrides work without a profile", () => {
    const policy = resolvePolicy({ trivialMaxFiles: 7, trivialMaxLines: 50 })
    expect(policy.trivialMaxFiles).toBe(7)
    expect(policy.trivialMaxLines).toBe(50)
    expect(policy.profile).toBeNull()
    expect(policy.source).toBe("project")
  })
})

// ─── readProjectSettings unit tests ────────────────────────────────────────

describe("readProjectSettings", () => {
  test("returns null when config.json does not exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "swiz-proj-"))
    tempDirs.push(dir)
    expect(await readProjectSettings(dir)).toBeNull()
  })

  test("reads valid profile from config.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "swiz-proj-"))
    tempDirs.push(dir)
    await mkdir(join(dir, ".swiz"), { recursive: true })
    await writeFile(join(dir, ".swiz", "config.json"), JSON.stringify({ profile: "strict" }))
    const settings = await readProjectSettings(dir)
    expect(settings?.profile).toBe("strict")
  })

  test("reads trivialMaxFiles and trivialMaxLines overrides", async () => {
    const dir = await mkdtemp(join(tmpdir(), "swiz-proj-"))
    tempDirs.push(dir)
    await mkdir(join(dir, ".swiz"), { recursive: true })
    await writeFile(
      join(dir, ".swiz", "config.json"),
      JSON.stringify({ trivialMaxFiles: 8, trivialMaxLines: 60 })
    )
    const settings = await readProjectSettings(dir)
    expect(settings?.trivialMaxFiles).toBe(8)
    expect(settings?.trivialMaxLines).toBe(60)
    expect(settings?.profile).toBeUndefined()
  })

  test("returns null for invalid profile value", async () => {
    const dir = await mkdtemp(join(tmpdir(), "swiz-proj-"))
    tempDirs.push(dir)
    await mkdir(join(dir, ".swiz"), { recursive: true })
    await writeFile(join(dir, ".swiz", "config.json"), JSON.stringify({ profile: "invalid" }))
    expect(await readProjectSettings(dir)).toBeNull()
  })

  test("returns null for malformed JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "swiz-proj-"))
    tempDirs.push(dir)
    await mkdir(join(dir, ".swiz"), { recursive: true })
    await writeFile(join(dir, ".swiz", "config.json"), "not-json{{{")
    expect(await readProjectSettings(dir)).toBeNull()
  })
})
