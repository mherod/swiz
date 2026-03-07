import { beforeAll, describe, expect, test } from "bun:test"
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { useTempDir } from "../../hooks/test-utils.ts"
import {
  ALL_STATUS_LINE_SEGMENTS,
  DEFAULT_TRIVIAL_MAX_FILES,
  DEFAULT_TRIVIAL_MAX_LINES,
  getEffectiveSwizSettings,
  POLICY_PROFILES,
  readProjectSettings,
  readSwizSettings,
  resolvePolicy,
} from "../settings.ts"
import { projectKeyFromCwd } from "../transcript-utils.ts"
import { SETTINGS_REGISTRY } from "./settings.ts"

const _tmp = useTempDir("swiz-settings-test-")
async function createTempHome(): Promise<string> {
  return realpath(await _tmp.create())
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

async function createGeminiSession(
  home: string,
  targetDir: string,
  sessionId: string
): Promise<void> {
  const bucket = targetDir.split(/[\\/]/).filter(Boolean).at(-1) ?? "project"
  const bucketDir = join(home, ".gemini", "tmp", bucket)
  const chatsDir = join(bucketDir, "chats")
  await mkdir(chatsDir, { recursive: true })
  await writeFile(join(bucketDir, ".project_root"), `${targetDir}\n`)
  await writeFile(
    join(chatsDir, "session-2026-03-05T10-00-abcdef12.json"),
    JSON.stringify({
      sessionId,
      messages: [
        { type: "user", content: [{ text: "hello" }], timestamp: "2026-03-05T10:00:00.000Z" },
        { type: "gemini", content: "hi", timestamp: "2026-03-05T10:00:01.000Z" },
      ],
    })
  )
}

async function createAntigravitySession(
  home: string,
  targetDir: string,
  sessionId: string
): Promise<void> {
  const conversationsDir = join(home, ".gemini", "antigravity", "conversations")
  const brainDir = join(home, ".gemini", "antigravity", "brain", sessionId)
  await mkdir(conversationsDir, { recursive: true })
  await mkdir(brainDir, { recursive: true })
  await writeFile(join(conversationsDir, `${sessionId}.pb`), Buffer.from([0x0a, 0x01, 0x00]))
  await writeFile(join(brainDir, "task.md"), `# Task\nThis session targets file://${targetDir}\n`)
}

async function createCodexSession(
  home: string,
  targetDir: string,
  sessionId: string
): Promise<void> {
  const codexDir = join(home, ".codex", "sessions", "2026", "03", "05")
  await mkdir(codexDir, { recursive: true })
  await writeFile(
    join(codexDir, `rollout-2026-03-05T10-00-00-${sessionId}.jsonl`),
    `${[
      JSON.stringify({
        timestamp: "2026-03-05T10:00:00.000Z",
        type: "session_meta",
        payload: {
          id: sessionId,
          timestamp: "2026-03-05T10:00:00.000Z",
          cwd: targetDir,
          originator: "codex_cli_rs",
        },
      }),
      JSON.stringify({
        timestamp: "2026-03-05T10:00:01.000Z",
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "Configure session setting",
        },
      }),
    ].join("\n")}\n`
  )
}

describe("swiz settings", () => {
  // ── Default output: share one subprocess ──────────────────────────────
  describe("default settings output", () => {
    let result: Awaited<ReturnType<typeof runSwiz>>

    beforeAll(async () => {
      const home = await createTempHome()
      result = await runSwiz(["settings"], home)
    })

    test("shows default auto-continue state", () => {
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain("auto-continue:   enabled")
      expect(result.stdout).toContain("pr-merge-mode:   enabled")
      expect(result.stdout).toContain("update-memory-footer: disabled")
      expect(result.stdout).toContain("(defaults)")
    })

    test("shows default narrator-voice and narrator-speed", () => {
      expect(result.stdout).toContain("narrator-voice:  system default")
      expect(result.stdout).toContain("narrator-speed:  system default")
    })

    test("shows default project policy", () => {
      expect(result.stdout).toContain("project policy")
      expect(result.stdout).toContain(`trivial-max-files: ${DEFAULT_TRIVIAL_MAX_FILES}`)
      expect(result.stdout).toContain(`trivial-max-lines: ${DEFAULT_TRIVIAL_MAX_LINES}`)
      expect(result.stdout).toContain("(default)")
    })

    test("shows default collaboration mode", () => {
      expect(result.stdout).toContain("collaboration:   auto")
    })
  })

  // ── Boolean toggle persistence: run concurrently ──────────────────────
  test("boolean settings persist correctly via enable/disable", async () => {
    const cases: Array<{
      args: string[]
      key: string
      expected: boolean
    }> = [
      { args: ["enable", "update-memory-footer"], key: "updateMemoryFooter", expected: true },
      { args: ["disable", "auto-continue"], key: "autoContinue", expected: false },
      { args: ["disable", "pr-merge-mode"], key: "prMergeMode", expected: false },
      { args: ["disable", "changes-requested-gate"], key: "changesRequestedGate", expected: false },
      { args: ["disable", "pr-review-gate"], key: "changesRequestedGate", expected: false },
      {
        args: ["disable", "personal-repo-issues-gate"],
        key: "personalRepoIssuesGate",
        expected: false,
      },
      { args: ["disable", "issue-gate"], key: "personalRepoIssuesGate", expected: false },
    ]
    await Promise.all(
      cases.map(async ({ args, key, expected }) => {
        const home = await createTempHome()
        const result = await runSwiz(["settings", ...args], home)
        expect(result.exitCode).toBe(0)
        const text = await readFile(join(home, ".swiz", "settings.json"), "utf-8")
        const json = JSON.parse(text) as Record<string, unknown>
        expect(json[key]).toBe(expected)
      })
    )
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

  test("resolves Gemini session IDs for --session scope", async () => {
    const home = await createTempHome()
    const targetDir = join(home, "repo")
    const sessionId = "dddddddd-dddd-dddd-dddd-dddddddddddd"
    await createGeminiSession(home, targetDir, sessionId)

    const result = await runSwiz(
      ["settings", "show", "--session", sessionId.slice(0, 8), "--dir", targetDir],
      home
    )
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain(`scope: session ${sessionId}`)
  })

  test("resolves Antigravity session IDs for --session scope", async () => {
    const home = await createTempHome()
    const targetDir = join(home, "repo")
    const sessionId = "5ec0dc8b-d56f-49da-91b5-9dbdfafdd7f3"
    await createAntigravitySession(home, targetDir, sessionId)

    const result = await runSwiz(
      ["settings", "show", "--session", sessionId.slice(0, 8), "--dir", targetDir],
      home
    )
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain(`scope: session ${sessionId}`)
  })

  test("resolves Codex session IDs for --session scope", async () => {
    const home = await createTempHome()
    const targetDir = join(home, "repo")
    const sessionId = "019cbc03-1111-7222-8333-444444444444"
    await createCodexSession(home, targetDir, sessionId)

    const result = await runSwiz(
      ["settings", "show", "--session", sessionId.slice(0, 8), "--dir", targetDir],
      home
    )
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain(`scope: session ${sessionId}`)
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

  // ── Set-value tests: run concurrently ───────────────────────────────
  test("set-value settings persist correctly", async () => {
    const cases: Array<{
      args: string[]
      key: string
      expected: unknown
      stdout?: string
    }> = [
      {
        args: ["set", "narrator-voice", "Samantha"],
        key: "narratorVoice",
        expected: "Samantha",
        stdout: "Set narrator-voice = Samantha",
      },
      {
        args: ["set", "narrator-speed", "250"],
        key: "narratorSpeed",
        expected: 250,
        stdout: "Set narrator-speed = 250",
      },
      {
        args: ["set", "ambition-mode", "standard"],
        key: "ambitionMode",
        expected: "standard",
        stdout: "Set ambition-mode = standard",
      },
      {
        args: ["set", "ambition-mode", "aggressive"],
        key: "ambitionMode",
        expected: "aggressive",
        stdout: "Set ambition-mode = aggressive",
      },
      {
        args: ["set", "ambition-mode", "creative"],
        key: "ambitionMode",
        expected: "creative",
        stdout: "Set ambition-mode = creative",
      },
    ]
    await Promise.all(
      cases.map(async ({ args, key, expected, stdout }) => {
        const home = await createTempHome()
        const result = await runSwiz(["settings", ...args], home)
        expect(result.exitCode).toBe(0)
        if (stdout) expect(result.stdout).toContain(stdout)
        const text = await readFile(join(home, ".swiz", "settings.json"), "utf-8")
        const json = JSON.parse(text) as Record<string, unknown>
        expect(json[key]).toBe(expected)
      })
    )
  })

  test("configured values appear in settings output", async () => {
    const [voiceHome, speedHome] = await Promise.all([createTempHome(), createTempHome()])
    await Promise.all([
      runSwiz(["settings", "set", "narrator-voice", "Alex"], voiceHome),
      runSwiz(["settings", "set", "narrator-speed", "180"], speedHome),
    ])
    const [voiceResult, speedResult] = await Promise.all([
      runSwiz(["settings"], voiceHome),
      runSwiz(["settings"], speedHome),
    ])
    expect(voiceResult.stdout).toContain("narrator-voice:  Alex")
    expect(speedResult.stdout).toContain("narrator-speed:  180 wpm")
  })

  // ── Rejection tests: run concurrently ─────────────────────────────────
  test("rejects invalid setting operations", async () => {
    const cases: Array<{
      args: string[]
      exitCode: number
      stderr: string
    }> = [
      { args: ["enable", "narrator-voice"], exitCode: 1, stderr: "not a boolean setting" },
      { args: ["enable", "ambition-mode"], exitCode: 1, stderr: "not a boolean setting" },
      { args: ["set", "ambition-mode", "turbo"], exitCode: 1, stderr: "ambition-mode" },
    ]
    await Promise.all(
      cases.map(async ({ args, exitCode, stderr }) => {
        const home = await createTempHome()
        const result = await runSwiz(["settings", ...args], home)
        expect(result.exitCode).toBe(exitCode)
        expect(result.stderr).toContain(stderr)
      })
    )
  })

  test("rejects scope mismatches", async () => {
    const cases = [
      {
        setup: async (home: string) => {
          await createSession(home, "/tmp/fake-project", "sess-scope-test")
        },
        args: ["enable", "speak", "--session", "sess-scope-test"],
        stderr: "does not support --session scope",
      },
      {
        setup: async (_home: string) => {},
        args: ["enable", "speak", "--project", "--dir", "HOME_PLACEHOLDER"],
        stderr: "does not support --project scope",
      },
      {
        setup: async (home: string) => {
          await createSession(home, "/tmp/fake-project", "sess-voice-test")
        },
        args: ["set", "narrator-voice", "Alex", "--session", "sess-voice-test"],
        stderr: "does not support --session scope",
      },
    ]
    await Promise.all(
      cases.map(async ({ setup, args, stderr }) => {
        const home = await createTempHome()
        await setup(home)
        const resolvedArgs = args.map((a) => (a === "HOME_PLACEHOLDER" ? home : a))
        const result = await runSwiz(["settings", ...resolvedArgs], home)
        expect(result.exitCode).toBe(1)
        expect(result.stderr).toContain(stderr)
      })
    )
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

  test("accepts --session for ambition-mode", async () => {
    const home = await createTempHome()
    const swizDir = join(home, ".swiz")
    await mkdir(swizDir, { recursive: true })
    await writeFile(join(swizDir, "settings.json"), JSON.stringify({ autoContinue: true }))
    await createSession(home, home, "sess-ambition-test")

    const result = await runSwiz(
      ["settings", "set", "ambition-mode", "creative", "--session", "sess-ambition-test"],
      home
    )
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("Set ambition-mode = creative")

    const configPath = join(home, ".swiz", "settings.json")
    const text = await readFile(configPath, "utf-8")
    const json = JSON.parse(text) as {
      sessions?: Record<string, { ambitionMode?: string }>
    }
    expect(json.sessions?.["sess-ambition-test"]?.ambitionMode).toBe("creative")
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

  test("accepts --project for ambition-mode", async () => {
    const home = await createTempHome()
    const result = await runSwiz(
      ["settings", "set", "ambition-mode", "creative", "--project", "--dir", home],
      home
    )
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("Set ambition-mode = creative")

    const configPath = join(home, ".swiz", "config.json")
    const text = await readFile(configPath, "utf-8")
    const json = JSON.parse(text) as { ambitionMode?: string }
    expect(json.ambitionMode).toBe("creative")
  })

  test("accepts --project for default-branch", async () => {
    const home = await createTempHome()
    const result = await runSwiz(
      ["settings", "set", "default-branch", "trunk", "--project", "--dir", home],
      home
    )
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("Set default-branch = trunk")

    const configPath = join(home, ".swiz", "config.json")
    const text = await readFile(configPath, "utf-8")
    const json = JSON.parse(text) as { defaultBranch?: string }
    expect(json.defaultBranch).toBe("trunk")
  })

  test("rejects invalid default-branch values with whitespace", async () => {
    const home = await createTempHome()
    const result = await runSwiz(
      ["settings", "set", "default-branch", "release branch", "--project", "--dir", home],
      home
    )
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("default-branch")
    expect(result.stderr).toContain("whitespace")
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
    const projectDir = await _tmp.create("swiz-policy-test-")
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

  test("collaboration-mode set/reject/show", async () => {
    const [setHome, rejectHome, showHome] = await Promise.all([
      createTempHome(),
      createTempHome(),
      createTempHome(),
    ])

    const [setResult, rejectResult] = await Promise.all([
      runSwiz(["settings", "set", "collaboration-mode", "solo"], setHome),
      runSwiz(["settings", "set", "collaboration-mode", "invalid"], rejectHome),
      runSwiz(["settings", "set", "collaboration-mode", "team"], showHome),
    ])

    // Set persists
    expect(setResult.exitCode).toBe(0)
    expect(setResult.stdout).toContain("Set collaboration-mode = solo")
    const text = await readFile(join(setHome, ".swiz", "settings.json"), "utf-8")
    expect((JSON.parse(text) as { collaborationMode?: string }).collaborationMode).toBe("solo")

    // Invalid value rejected
    expect(rejectResult.exitCode).not.toBe(0)
    expect(rejectResult.stderr).toContain("Invalid value")

    // Non-default value shows in output
    const showResult = await runSwiz(["settings"], showHome)
    expect(showResult.stdout).toContain("collaboration:   team")
  })

  test("settings show includes project-level disabled hooks", async () => {
    const home = await createTempHome()
    const projectDir = await _tmp.create("swiz-disabled-hooks-test-")
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
    const dir = await _tmp.create("swiz-proj-")
    expect(await readProjectSettings(dir)).toBeNull()
  })

  test("reads valid profile from config.json", async () => {
    const dir = await _tmp.create("swiz-proj-")
    await mkdir(join(dir, ".swiz"), { recursive: true })
    await writeFile(join(dir, ".swiz", "config.json"), JSON.stringify({ profile: "strict" }))
    const settings = await readProjectSettings(dir)
    expect(settings?.profile).toBe("strict")
  })

  test("reads ambitionMode from project config", async () => {
    const dir = await _tmp.create("swiz-proj-")
    await mkdir(join(dir, ".swiz"), { recursive: true })
    await writeFile(join(dir, ".swiz", "config.json"), JSON.stringify({ ambitionMode: "creative" }))
    const settings = await readProjectSettings(dir)
    expect(settings?.ambitionMode).toBe("creative")
  })

  test("reads trivialMaxFiles and trivialMaxLines overrides", async () => {
    const dir = await _tmp.create("swiz-proj-")
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
    const dir = await _tmp.create("swiz-proj-")
    await mkdir(join(dir, ".swiz"), { recursive: true })
    await writeFile(join(dir, ".swiz", "config.json"), JSON.stringify({ profile: "invalid" }))
    expect(await readProjectSettings(dir)).toBeNull()
  })

  test("returns null for malformed JSON", async () => {
    const dir = await _tmp.create("swiz-proj-")
    await mkdir(join(dir, ".swiz"), { recursive: true })
    await writeFile(join(dir, ".swiz", "config.json"), "not-json{{{")
    expect(await readProjectSettings(dir)).toBeNull()
  })

  test("reads disabledHooks array from config.json", async () => {
    const dir = await _tmp.create("swiz-proj-")
    await mkdir(join(dir, ".swiz"), { recursive: true })
    await writeFile(
      join(dir, ".swiz", "config.json"),
      JSON.stringify({ disabledHooks: ["stop-github-ci.ts", "stop-lint-staged.ts"] })
    )
    const settings = await readProjectSettings(dir)
    expect(settings?.disabledHooks).toEqual(["stop-github-ci.ts", "stop-lint-staged.ts"])
  })

  test("ignores disabledHooks when entries contain non-string values", async () => {
    const dir = await _tmp.create("swiz-proj-")
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
    // All settings must be present with no gaps between the registry and CLI behavior.
    const expectedKeys = [
      "autoContinue",
      "prMergeMode",
      "critiquesEnabled",
      "pushGate",
      "sandboxedEdits",
      "speak",
      "updateMemoryFooter",
      "gitStatusGate",
      "nonDefaultBranchGate",
      "githubCiGate",
      "changesRequestedGate",
      "personalRepoIssuesGate",
      "prAgeGateMinutes",
      "pushCooldownMinutes",
      "narratorSpeed",
      "memoryLineThreshold",
      "memoryWordThreshold",
      "defaultBranch",
      "narratorVoice",
      "ambitionMode",
      "collaborationMode",
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
    expect(def!.validate!("creative")).toBeNull()
    expect(def!.validate!("turbo")).toContain("Invalid value")
  })

  test("string settings without validators accept any value", () => {
    const narratorVoice = SETTINGS_REGISTRY.find((d) => d.key === "narratorVoice")
    expect(narratorVoice).toBeDefined()
    expect(narratorVoice!.validate).toBeUndefined()
  })

  test("collaborationMode has a validator that rejects invalid values", () => {
    const def = SETTINGS_REGISTRY.find((d) => d.key === "collaborationMode")
    expect(def).toBeDefined()
    expect(def!.validate).toBeDefined()
    expect(def!.validate!("auto")).toBeNull()
    expect(def!.validate!("solo")).toBeNull()
    expect(def!.validate!("team")).toBeNull()
    expect(def!.validate!("invalid")).toContain("Invalid value")
  })

  test("collaborationMode supports global and session scopes", () => {
    const def = SETTINGS_REGISTRY.find((d) => d.key === "collaborationMode")
    expect(def).toBeDefined()
    expect(def!.scopes).toContain("global")
    expect(def!.scopes).toContain("session")
  })
})

// ─── collaborationMode normalization + effective settings ────────────────────

describe("collaborationMode settings", () => {
  test("defaults to auto when no config exists", async () => {
    const home = await createTempHome()
    const settings = await readSwizSettings({ home })
    expect(settings.collaborationMode).toBe("auto")
  })

  test("normalizes valid collaborationMode values from config", async () => {
    const home = await createTempHome()
    const configDir = join(home, ".swiz")
    await mkdir(configDir, { recursive: true })
    await writeFile(join(configDir, "settings.json"), JSON.stringify({ collaborationMode: "team" }))
    const settings = await readSwizSettings({ home })
    expect(settings.collaborationMode).toBe("team")
  })

  test("falls back to auto for invalid collaborationMode values", async () => {
    const home = await createTempHome()
    const configDir = join(home, ".swiz")
    await mkdir(configDir, { recursive: true })
    await writeFile(
      join(configDir, "settings.json"),
      JSON.stringify({ collaborationMode: "invalid" })
    )
    const settings = await readSwizSettings({ home })
    expect(settings.collaborationMode).toBe("auto")
  })

  test("effective settings inherit collaborationMode from global", () => {
    const settings = {
      autoContinue: true,
      critiquesEnabled: true,
      ambitionMode: "standard" as const,
      collaborationMode: "solo" as const,
      narratorVoice: "",
      narratorSpeed: 0,
      prAgeGateMinutes: 10,
      prMergeMode: true,
      pushCooldownMinutes: 0,
      pushGate: false,
      sandboxedEdits: true,
      speak: false,
      updateMemoryFooter: false,
      gitStatusGate: true,
      nonDefaultBranchGate: true,
      githubCiGate: true,
      changesRequestedGate: true,
      personalRepoIssuesGate: true,
      memoryLineThreshold: 1400,
      memoryWordThreshold: 5000,
      statusLineSegments: [...ALL_STATUS_LINE_SEGMENTS],
      sessions: {},
    }
    const effective = getEffectiveSwizSettings(settings)
    expect(effective.collaborationMode).toBe("solo")
  })

  test("session collaborationMode overrides global", () => {
    const settings = {
      autoContinue: true,
      critiquesEnabled: true,
      ambitionMode: "standard" as const,
      collaborationMode: "auto" as const,
      narratorVoice: "",
      narratorSpeed: 0,
      prAgeGateMinutes: 10,
      prMergeMode: true,
      pushCooldownMinutes: 0,
      pushGate: false,
      sandboxedEdits: true,
      speak: false,
      updateMemoryFooter: false,
      gitStatusGate: true,
      nonDefaultBranchGate: true,
      githubCiGate: true,
      changesRequestedGate: true,
      personalRepoIssuesGate: true,
      memoryLineThreshold: 1400,
      memoryWordThreshold: 5000,
      statusLineSegments: [...ALL_STATUS_LINE_SEGMENTS],
      sessions: {
        "test-session": {
          autoContinue: true,
          collaborationMode: "team" as const,
        },
      },
    }
    const effective = getEffectiveSwizSettings(settings, "test-session")
    expect(effective.collaborationMode).toBe("team")
    expect(effective.source).toBe("session")
  })

  test("session without collaborationMode falls back to global", () => {
    const settings = {
      autoContinue: true,
      critiquesEnabled: true,
      ambitionMode: "standard" as const,
      collaborationMode: "solo" as const,
      narratorVoice: "",
      narratorSpeed: 0,
      prAgeGateMinutes: 10,
      prMergeMode: true,
      pushCooldownMinutes: 0,
      pushGate: false,
      sandboxedEdits: true,
      speak: false,
      updateMemoryFooter: false,
      gitStatusGate: true,
      nonDefaultBranchGate: true,
      githubCiGate: true,
      changesRequestedGate: true,
      personalRepoIssuesGate: true,
      memoryLineThreshold: 1400,
      memoryWordThreshold: 5000,
      statusLineSegments: [...ALL_STATUS_LINE_SEGMENTS],
      sessions: {
        "test-session": {
          autoContinue: true,
        },
      },
    }
    const effective = getEffectiveSwizSettings(settings, "test-session")
    expect(effective.collaborationMode).toBe("solo")
  })

  test("project ambitionMode overrides global when no session override", () => {
    const settings = {
      autoContinue: true,
      critiquesEnabled: true,
      ambitionMode: "standard" as const,
      collaborationMode: "solo" as const,
      narratorVoice: "",
      narratorSpeed: 0,
      prAgeGateMinutes: 10,
      prMergeMode: true,
      pushCooldownMinutes: 0,
      pushGate: false,
      sandboxedEdits: true,
      speak: false,
      updateMemoryFooter: false,
      gitStatusGate: true,
      nonDefaultBranchGate: true,
      githubCiGate: true,
      changesRequestedGate: true,
      personalRepoIssuesGate: true,
      memoryLineThreshold: 1400,
      memoryWordThreshold: 5000,
      statusLineSegments: [...ALL_STATUS_LINE_SEGMENTS],
      sessions: {},
    }
    const effective = getEffectiveSwizSettings(settings, null, { ambitionMode: "creative" })
    expect(effective.ambitionMode).toBe("creative")
  })

  test("session ambitionMode overrides project and global", () => {
    const settings = {
      autoContinue: true,
      critiquesEnabled: true,
      ambitionMode: "standard" as const,
      collaborationMode: "auto" as const,
      narratorVoice: "",
      narratorSpeed: 0,
      prAgeGateMinutes: 10,
      prMergeMode: true,
      pushCooldownMinutes: 0,
      pushGate: false,
      sandboxedEdits: true,
      speak: false,
      updateMemoryFooter: false,
      gitStatusGate: true,
      nonDefaultBranchGate: true,
      githubCiGate: true,
      changesRequestedGate: true,
      personalRepoIssuesGate: true,
      memoryLineThreshold: 1400,
      memoryWordThreshold: 5000,
      statusLineSegments: [...ALL_STATUS_LINE_SEGMENTS],
      sessions: {
        "test-session": {
          autoContinue: true,
          ambitionMode: "aggressive" as const,
        },
      },
    }
    const effective = getEffectiveSwizSettings(
      settings,
      "test-session",
      { ambitionMode: "creative" } // project-level should lose to session override
    )
    expect(effective.ambitionMode).toBe("aggressive")
  })
})
