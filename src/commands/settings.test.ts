import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
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
import { SETTINGS_REGISTRY } from "./settings.ts"

const tempDirs: string[] = []

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (!dir) continue
    await rm(dir, { recursive: true, force: true })
  }
})

async function createTempHome(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "swiz-settings-test-")))
  tempDirs.push(dir)
  return dir
}

async function runSwiz(
  args: string[],
  home: string
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const indexPath = join(process.cwd(), "index.ts")
  const proc = Bun.spawn(["bun", "run", indexPath, ...args], {
    cwd: home,
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
    expect(result.stdout).toContain("pr-merge-mode:   enabled")
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

  test("disables pr-merge-mode and persists to user config", async () => {
    const home = await createTempHome()
    const result = await runSwiz(["settings", "disable", "pr-merge-mode"], home)
    expect(result.exitCode).toBe(0)

    const configPath = join(home, ".swiz", "settings.json")
    const text = await readFile(configPath, "utf-8")
    const json = JSON.parse(text) as { prMergeMode?: boolean }
    expect(json.prMergeMode).toBe(false)
  })

  test("disables changes-requested-gate and persists to user config", async () => {
    const home = await createTempHome()
    const result = await runSwiz(["settings", "disable", "changes-requested-gate"], home)
    expect(result.exitCode).toBe(0)

    const configPath = join(home, ".swiz", "settings.json")
    const text = await readFile(configPath, "utf-8")
    const json = JSON.parse(text) as { changesRequestedGate?: boolean }
    expect(json.changesRequestedGate).toBe(false)
  })

  test("accepts pr-review-gate as alias for changes-requested-gate", async () => {
    const home = await createTempHome()
    const result = await runSwiz(["settings", "disable", "pr-review-gate"], home)
    expect(result.exitCode).toBe(0)

    const configPath = join(home, ".swiz", "settings.json")
    const text = await readFile(configPath, "utf-8")
    const json = JSON.parse(text) as { changesRequestedGate?: boolean }
    expect(json.changesRequestedGate).toBe(false)
  })

  test("disables personal-repo-issues-gate and persists to user config", async () => {
    const home = await createTempHome()
    const result = await runSwiz(["settings", "disable", "personal-repo-issues-gate"], home)
    expect(result.exitCode).toBe(0)

    const configPath = join(home, ".swiz", "settings.json")
    const text = await readFile(configPath, "utf-8")
    const json = JSON.parse(text) as { personalRepoIssuesGate?: boolean }
    expect(json.personalRepoIssuesGate).toBe(false)
  })

  test("accepts issue-gate as alias for personalRepoIssuesGate", async () => {
    const home = await createTempHome()
    const result = await runSwiz(["settings", "disable", "issue-gate"], home)
    expect(result.exitCode).toBe(0)

    const configPath = join(home, ".swiz", "settings.json")
    const text = await readFile(configPath, "utf-8")
    const json = JSON.parse(text) as { personalRepoIssuesGate?: boolean }
    expect(json.personalRepoIssuesGate).toBe(false)
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
    expect(result.stdout).toContain(`(session ${sessionId})`)

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

  test("sets ambition-mode standard and persists to config", async () => {
    const home = await createTempHome()
    const result = await runSwiz(["settings", "set", "ambition-mode", "standard"], home)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("Set ambition-mode = standard")

    const configPath = join(home, ".swiz", "settings.json")
    const text = await readFile(configPath, "utf-8")
    const json = JSON.parse(text) as { ambitionMode?: string }
    expect(json.ambitionMode).toBe("standard")
  })

  test("sets ambition-mode aggressive and persists to config", async () => {
    const home = await createTempHome()
    const result = await runSwiz(["settings", "set", "ambition-mode", "aggressive"], home)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("Set ambition-mode = aggressive")

    const configPath = join(home, ".swiz", "settings.json")
    const text = await readFile(configPath, "utf-8")
    const json = JSON.parse(text) as { ambitionMode?: string }
    expect(json.ambitionMode).toBe("aggressive")
  })

  test("rejects invalid ambition-mode value", async () => {
    const home = await createTempHome()
    const result = await runSwiz(["settings", "set", "ambition-mode", "turbo"], home)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("ambition-mode")
  })

  test("rejects enable/disable for ambition-mode", async () => {
    const home = await createTempHome()
    const result = await runSwiz(["settings", "enable", "ambition-mode"], home)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("not a boolean setting")
  })

  test("rejects --session for a global-only setting", async () => {
    const home = await createTempHome()
    // Create a session so --session resolves
    await createSession(home, "/tmp/fake-project", "sess-scope-test")
    const result = await runSwiz(
      ["settings", "enable", "speak", "--session", "sess-scope-test"],
      home
    )
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("does not support --session scope")
  })

  test("rejects --project for a global-only setting", async () => {
    const home = await createTempHome()
    const result = await runSwiz(["settings", "enable", "speak", "--project", "--dir", home], home)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("does not support --project scope")
  })

  test("rejects --session for narrator-voice (set command)", async () => {
    const home = await createTempHome()
    await createSession(home, "/tmp/fake-project", "sess-voice-test")
    const result = await runSwiz(
      ["settings", "set", "narrator-voice", "Alex", "--session", "sess-voice-test"],
      home
    )
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("does not support --session scope")
  })

  test("accepts --session for auto-continue", async () => {
    const home = await createTempHome()
    // Ensure settings.json exists so readSwizSettings({ strict: true }) succeeds
    const swizDir = join(home, ".swiz")
    await mkdir(swizDir, { recursive: true })
    await writeFile(join(swizDir, "settings.json"), JSON.stringify({ autoContinue: false }))
    // Session must target the home dir (which is also cwd for the subprocess)
    await createSession(home, home, "sess-ac-test")
    const result = await runSwiz(
      ["settings", "enable", "auto-continue", "--session", "sess-ac-test"],
      home
    )
    expect(result.stderr).toBe("")
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("Enabled")
  })

  test("accepts --project for memory-line-threshold", async () => {
    const home = await createTempHome()
    const result = await runSwiz(
      ["settings", "set", "memory-line-threshold", "2000", "--project", "--dir", home],
      home
    )
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("Set memory-line-threshold = 2000")
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
    expect(result.stdout).toContain("pr-merge-mode:   enabled")
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

  test("disable-hook adds filename to user-level disabledHooks", async () => {
    const home = await createTempHome()
    const result = await runSwiz(["settings", "disable-hook", "stop-github-ci.ts"], home)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("Disabled hook: stop-github-ci.ts")

    const configPath = join(home, ".swiz", "settings.json")
    const text = await readFile(configPath, "utf-8")
    const json = JSON.parse(text) as { disabledHooks?: string[] }
    expect(json.disabledHooks).toEqual(["stop-github-ci.ts"])
  })

  test("disable-hook is idempotent when hook already disabled", async () => {
    const home = await createTempHome()
    await runSwiz(["settings", "disable-hook", "stop-github-ci.ts"], home)
    const result = await runSwiz(["settings", "disable-hook", "stop-github-ci.ts"], home)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("already disabled")

    const configPath = join(home, ".swiz", "settings.json")
    const text = await readFile(configPath, "utf-8")
    const json = JSON.parse(text) as { disabledHooks?: string[] }
    expect(json.disabledHooks).toEqual(["stop-github-ci.ts"])
  })

  test("enable-hook removes filename from disabledHooks", async () => {
    const home = await createTempHome()
    await runSwiz(["settings", "disable-hook", "stop-github-ci.ts"], home)
    await runSwiz(["settings", "disable-hook", "stop-lint-staged.ts"], home)
    const result = await runSwiz(["settings", "enable-hook", "stop-github-ci.ts"], home)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("Re-enabled hook: stop-github-ci.ts")

    const configPath = join(home, ".swiz", "settings.json")
    const text = await readFile(configPath, "utf-8")
    const json = JSON.parse(text) as { disabledHooks?: string[] }
    expect(json.disabledHooks).toEqual(["stop-lint-staged.ts"])
  })

  test("enable-hook is a no-op when hook is not in the disabled list", async () => {
    const home = await createTempHome()
    const result = await runSwiz(["settings", "enable-hook", "stop-github-ci.ts"], home)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("not in the disabled list")
  })

  test("settings show includes disabled-hooks line when hooks are disabled", async () => {
    const home = await createTempHome()
    await runSwiz(["settings", "disable-hook", "stop-github-ci.ts"], home)
    const result = await runSwiz(["settings"], home)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("disabled-hooks:  stop-github-ci.ts (global)")
  })

  test("settings show lists multiple disabled hooks", async () => {
    const home = await createTempHome()
    await runSwiz(["settings", "disable-hook", "stop-github-ci.ts"], home)
    await runSwiz(["settings", "disable-hook", "stop-lint-staged.ts"], home)
    const result = await runSwiz(["settings"], home)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("stop-github-ci.ts, stop-lint-staged.ts")
  })

  test("settings show includes project-level disabled hooks", async () => {
    const home = await createTempHome()
    const projectDir = await mkdtemp(join(tmpdir(), "swiz-disabled-hooks-test-"))
    tempDirs.push(projectDir)
    const swizDir = join(projectDir, ".swiz")
    await mkdir(swizDir, { recursive: true })
    await writeFile(
      join(swizDir, "config.json"),
      JSON.stringify({ disabledHooks: ["stop-git-status.ts"] })
    )

    const result = await runSwiz(["settings", "--dir", projectDir], home)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("disabled-hooks:  stop-git-status.ts (project)")
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

  test("reads disabledHooks array from config.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "swiz-proj-"))
    tempDirs.push(dir)
    await mkdir(join(dir, ".swiz"), { recursive: true })
    await writeFile(
      join(dir, ".swiz", "config.json"),
      JSON.stringify({ disabledHooks: ["stop-github-ci.ts", "stop-lint-staged.ts"] })
    )
    const settings = await readProjectSettings(dir)
    expect(settings?.disabledHooks).toEqual(["stop-github-ci.ts", "stop-lint-staged.ts"])
  })

  test("ignores disabledHooks when entries contain non-string values", async () => {
    const dir = await mkdtemp(join(tmpdir(), "swiz-proj-"))
    tempDirs.push(dir)
    await mkdir(join(dir, ".swiz"), { recursive: true })
    await writeFile(
      join(dir, ".swiz", "config.json"),
      JSON.stringify({ disabledHooks: ["stop-github-ci.ts", 42] })
    )
    const settings = await readProjectSettings(dir)
    expect(settings?.disabledHooks).toBeUndefined()
  })
})

// ─── SETTINGS_REGISTRY unit tests ───────────────────────────────────────────

describe("SETTINGS_REGISTRY", () => {
  test("every entry has at least one alias", () => {
    for (const def of SETTINGS_REGISTRY) {
      expect(def.aliases.length).toBeGreaterThan(0)
    }
  })

  test("no duplicate aliases across entries", () => {
    const seen = new Map<string, string>()
    for (const def of SETTINGS_REGISTRY) {
      for (const alias of def.aliases) {
        const existing = seen.get(alias)
        if (existing) {
          throw new Error(`Duplicate alias "${alias}" in both "${existing}" and "${def.key}"`)
        }
        seen.set(alias, def.key)
      }
    }
  })

  test("no duplicate canonical keys", () => {
    const keys = SETTINGS_REGISTRY.map((d) => d.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  test("every entry has at least one valid scope", () => {
    for (const def of SETTINGS_REGISTRY) {
      expect(def.scopes.length).toBeGreaterThan(0)
      for (const scope of def.scopes) {
        expect(["global", "project", "session"]).toContain(scope)
      }
    }
  })

  test("adding a setting only requires one registry entry", () => {
    // Verify the registry drives alias resolution, type guards, and scope validation.
    // All 17 settings must be present with no gaps between the registry and CLI behavior.
    const expectedKeys = [
      "autoContinue",
      "prMergeMode",
      "critiquesEnabled",
      "pushGate",
      "sandboxedEdits",
      "speak",
      "gitStatusGate",
      "nonDefaultBranchGate",
      "githubCiGate",
      "changesRequestedGate",
      "personalRepoIssuesGate",
      "prAgeGateMinutes",
      "narratorSpeed",
      "memoryLineThreshold",
      "memoryWordThreshold",
      "narratorVoice",
      "ambitionMode",
    ]
    const registryKeys = SETTINGS_REGISTRY.map((d) => d.key)
    for (const key of expectedKeys) {
      expect(registryKeys).toContain(key)
    }
    expect(registryKeys.length).toBe(expectedKeys.length)
  })

  test("ambitionMode has a validator that rejects invalid values", () => {
    const def = SETTINGS_REGISTRY.find((d) => d.key === "ambitionMode")
    expect(def).toBeDefined()
    expect(def!.validate).toBeDefined()
    expect(def!.validate!("standard")).toBeNull()
    expect(def!.validate!("aggressive")).toBeNull()
    expect(def!.validate!("turbo")).toContain("Invalid value")
  })

  test("string settings without validators accept any value", () => {
    const narratorVoice = SETTINGS_REGISTRY.find((d) => d.key === "narratorVoice")
    expect(narratorVoice).toBeDefined()
    expect(narratorVoice!.validate).toBeUndefined()
  })
})
