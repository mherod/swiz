import { beforeAll, describe, expect, test } from "bun:test"
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { useTempDir, writeClaudeSession } from "../../hooks/utils/test-utils.ts"
import {
  ALL_STATUS_LINE_SEGMENTS,
  DEFAULT_TRIVIAL_MAX_FILES,
  DEFAULT_TRIVIAL_MAX_LINES,
  getEffectiveSwizSettings,
  POLICY_PROFILES,
  readProjectSettings,
  readSwizSettings,
  resolvePolicy,
  SETTINGS_REGISTRY,
} from "../settings.ts"
import { createAntigravitySession, createCodexSession } from "../test-fixtures.ts"
import { settingsCommand } from "./settings.ts"

const _tmp = useTempDir("swiz-settings-test-")
async function createTempHome(): Promise<string> {
  return realpath(await _tmp.create())
}

/** Git repo with no `.swiz/` so project settings do not pick up the real checkout. */
async function createIsolatedGitProject(parentDir: string): Promise<string> {
  const dir = join(parentDir, "isolated-repo")
  await mkdir(dir, { recursive: true })
  const init = Bun.spawnSync(["git", "init"], { cwd: dir, stdout: "pipe", stderr: "pipe" })
  if (init.exitCode !== 0) {
    throw new Error(`git init failed: ${new TextDecoder().decode(init.stderr)}`)
  }
  return dir
}

// Serialize in-process calls — they mutate process.env.HOME and console
let _inProcessQueue: Promise<unknown> = Promise.resolve()

/**
 * Run the settings command in-process with a temporary HOME directory.
 * Captures console.log (stdout) and console.error/console.warn (stderr).
 * Returns exitCode 0 on success, 1 on thrown error.
 * Serialized via a queue to prevent HOME/console collisions in concurrent callers.
 */
async function runSwiz(
  args: string[],
  home: string
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  // Only handle `settings` subcommand in-process; delegate `help` to subprocess
  if (args[0] !== "settings") {
    const indexPath = join(process.cwd(), "index.ts")
    const proc = Bun.spawn(["bun", "run", indexPath, ...args], {
      cwd: home,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HOME: home },
    })
    void proc.stdin.end()
    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()
    await proc.exited
    return { stdout, stderr, exitCode: proc.exitCode }
  }

  // Enqueue to serialize — concurrent callers wait for the previous to finish
  const result = _inProcessQueue.then(async () => {
    const prevHome = process.env.HOME
    process.env.HOME = home

    const stdoutLines: string[] = []
    const stderrLines: string[] = []
    const origLog = console.log
    const origError = console.error
    const origWarn = console.warn
    console.log = (...a: unknown[]) => stdoutLines.push(a.map(String).join(" "))
    console.error = (...a: unknown[]) => stderrLines.push(a.map(String).join(" "))
    console.warn = (...a: unknown[]) => stderrLines.push(a.map(String).join(" "))

    let exitCode = 0
    try {
      await settingsCommand.run(args.slice(1))
    } catch (err) {
      exitCode = 1
      stderrLines.push(err instanceof Error ? err.message : String(err))
    } finally {
      console.log = origLog
      console.error = origError
      console.warn = origWarn
      process.env.HOME = prevHome
    }

    return {
      stdout: stdoutLines.join("\n"),
      stderr: stderrLines.join("\n"),
      exitCode,
    }
  })
  _inProcessQueue = result.catch(() => {})
  return result
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

describe("swiz settings", () => {
  // ── Default output: share one subprocess ──────────────────────────────
  describe("default settings output", () => {
    let result: Awaited<ReturnType<typeof runSwiz>>

    beforeAll(async () => {
      const home = await createTempHome()
      const projectDir = await createIsolatedGitProject(home)
      result = await runSwiz(["settings", "--dir", projectDir], home)
    })

    test("shows default auto-continue state", () => {
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain("auto-continue:   enabled")
      expect(result.stdout).toMatch(/pr-merge-mode:\s+enabled/)
      expect(result.stdout).toMatch(/update-memory-footer:\s+disabled/)
      expect(result.stdout).toContain("(defaults)")
    })

    test("shows default narrator-voice and narrator-speed", () => {
      expect(result.stdout).toContain("narrator-voice: system default")
      expect(result.stdout).toContain("narrator-speed: system default")
    })

    test("shows default project policy", () => {
      expect(result.stdout).toContain("project policy")
      expect(result.stdout).toContain(`trivial-max-files: ${DEFAULT_TRIVIAL_MAX_FILES}`)
      expect(result.stdout).toContain(`trivial-max-lines: ${DEFAULT_TRIVIAL_MAX_LINES}`)
      // Isolated --dir repo has no .swiz/config.json → policy lines use (default)
      expect(result.stdout).toMatch(/trivial-max-(files|lines):.*\(default\)/)
    })

    test("shows default collaboration mode", () => {
      expect(result.stdout).toContain("collaboration:")
      expect(result.stdout).toMatch(/collaboration:.*\((default|project)\)/)
    })
  })

  test("--json outputs valid JSON with all effective settings keys", async () => {
    const home = await createTempHome()
    const result = await runSwiz(["settings", "--json"], home)
    expect(result.exitCode).toBe(0)
    const parsed = JSON.parse(result.stdout)
    expect(typeof parsed).toBe("object")
    expect(parsed).toHaveProperty("autoContinue")
    expect(parsed).toHaveProperty("prMergeMode")
    expect(parsed).toHaveProperty("pushGate")
    expect(parsed).toHaveProperty("sandboxedEdits")
    expect(parsed).toHaveProperty("speak")
    expect(parsed).toHaveProperty("gitStatusGate")
    expect(parsed).toHaveProperty("ignoreCi")
    expect(parsed).toHaveProperty("memoryLineThreshold")
    expect(parsed).toHaveProperty("source")
  })

  test("--json enable outputs confirmation with setting key and value", async () => {
    const home = await createTempHome()
    const result = await runSwiz(["settings", "enable", "push-gate", "--json"], home)
    expect(result.exitCode).toBe(0)
    const parsed = JSON.parse(result.stdout)
    expect(parsed.action).toBe("enabled")
    expect(parsed.setting).toBe("pushGate")
    expect(parsed.value).toBe(true)
    expect(parsed).toHaveProperty("path")
  })

  test("--json disable outputs confirmation with setting key and value", async () => {
    const home = await createTempHome()
    const result = await runSwiz(["settings", "disable", "push-gate", "--json"], home)
    expect(result.exitCode).toBe(0)
    const parsed = JSON.parse(result.stdout)
    expect(parsed.action).toBe("disabled")
    expect(parsed.setting).toBe("pushGate")
    expect(parsed.value).toBe(false)
    expect(parsed).toHaveProperty("path")
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
  }, 30_000)

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
    await writeClaudeSession(home, targetDir, sessionId)

    const disableGlobal = await runSwiz(["settings", "disable", "auto-continue"], home)
    expect(disableGlobal.exitCode).toBe(0)

    const showSession = await runSwiz(
      ["settings", "show", "--session", sessionId.slice(0, 8), "--dir", targetDir],
      home
    )
    expect(showSession.exitCode).toBe(0)
    expect(showSession.stdout).toContain(`scope: session ${sessionId}`)
    expect(showSession.stdout).toContain("auto-continue:   disabled (global/default)")
  }, 30_000)

  test("session-scoped disable stores override under sessions map", async () => {
    const home = await createTempHome()
    const targetDir = join(home, "repo")
    const sessionId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
    await writeClaudeSession(home, targetDir, sessionId)

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
    await writeClaudeSession(home, targetDir, "cccccccc-cccc-cccc-cccc-cccccccccccc")

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
      {
        args: ["set", "ambition-mode", "reflective"],
        key: "ambitionMode",
        expected: "reflective",
        stdout: "Set ambition-mode = reflective",
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
    expect(voiceResult.stdout).toContain("narrator-voice: Alex")
    expect(speedResult.stdout).toContain("narrator-speed: 180 wpm")
  }, 30_000)

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
      // Numeric settings must reject trailing-junk values (parseInt silently accepts these)
      { args: ["set", "narrator-speed", "30abc"], exitCode: 1, stderr: "non-negative integer" },
      { args: ["set", "narrator-speed", "3.5"], exitCode: 1, stderr: "non-negative integer" },
      { args: ["set", "narrator-speed", "1e2"], exitCode: 1, stderr: "non-negative integer" },
      { args: ["set", "narrator-speed", "-1"], exitCode: 1, stderr: "non-negative integer" },
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
          await writeClaudeSession(home, "/tmp/fake-project", "sess-scope-test")
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
          await writeClaudeSession(home, "/tmp/fake-project", "sess-voice-test")
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
    await writeClaudeSession(home, home, "sess-ac-test")
    const result = await runSwiz(
      ["settings", "enable", "auto-continue", "--session", "sess-ac-test", "--dir", home],
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
    await writeClaudeSession(home, home, "sess-ambition-test")

    const result = await runSwiz(
      [
        "settings",
        "set",
        "ambition-mode",
        "creative",
        "--session",
        "sess-ambition-test",
        "--dir",
        home,
      ],
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

  test("accepts --project for collaboration-mode", async () => {
    const home = await createTempHome()
    const result = await runSwiz(
      ["settings", "set", "collaboration-mode", "team", "--project", "--dir", home],
      home
    )
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("Set collaboration-mode = team")

    const configPath = join(home, ".swiz", "config.json")
    const text = await readFile(configPath, "utf-8")
    const json = JSON.parse(text) as { collaborationMode?: string }
    expect(json.collaborationMode).toBe("team")
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
    expect(result.stdout).toMatch(/pr-merge-mode:\s+enabled/)
    expect(result.stdout).toMatch(/speak:\s+enabled/)
    expect(result.stdout).toContain("narrator-voice: system default")
    expect(result.stdout).toContain("narrator-speed: system default")
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
    expect(showResult.stdout).toContain("collaboration:")
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
  const primaryAlias = (key: string) =>
    SETTINGS_REGISTRY.find((d) => d.key === key)?.aliases[0] ?? key

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
      "autoSteer",
      "updateMemoryFooter",
      "gitStatusGate",
      "nonDefaultBranchGate",
      "githubCiGate",
      "ignoreCi",
      "changesRequestedGate",
      "personalRepoIssuesGate",
      "issueCloseGate",
      "qualityChecksGate",
      "prAgeGateMinutes",
      "pushCooldownMinutes",
      "taskDurationWarningMinutes",
      "narratorSpeed",
      "memoryLineThreshold",
      "memoryWordThreshold",
      "largeFileSizeKb",
      "defaultBranch",
      "narratorVoice",
      "ambitionMode",
      "collaborationMode",
      "strictNoDirectMain",
      "trunkMode",
      "dirtyWorktreeThreshold",
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
    expect(def!.validate!("reflective")).toBeNull()
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
    expect(def!.validate!("relaxed-collab")).toBeNull()
    expect(def!.validate!("invalid")).toContain("Invalid value")
  })

  test("collaborationMode supports global and session scopes", () => {
    const def = SETTINGS_REGISTRY.find((d) => d.key === "collaborationMode")
    expect(def).toBeDefined()
    expect(def!.scopes).toContain("global")
    expect(def!.scopes).toContain("session")
  })

  test("settings usage output includes project-scoped aliases from shared registry", async () => {
    const home = await createTempHome()
    const result = await runSwiz(["help", "settings"], home)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain(`set ${primaryAlias("largeFileSizeKb")} <kb>`)
    expect(result.stdout).toContain(`set ${primaryAlias("memoryLineThreshold")} <lines>`)
    expect(result.stdout).toContain(`set ${primaryAlias("defaultBranch")} <name>`)
  })

  test("settings help renders every shared registry key", async () => {
    const home = await createTempHome()
    const result = await runSwiz(["help", "settings"], home)
    expect(result.exitCode).toBe(0)
    for (const def of SETTINGS_REGISTRY) {
      const alias = def.aliases[0]
      expect(alias).toBeDefined()
      if (!alias) continue
      if (def.kind === "boolean") {
        expect(result.stdout).toContain(`enable ${alias}`)
        expect(result.stdout).toContain(`disable ${alias}`)
      } else {
        expect(result.stdout).toContain(`set ${alias}`)
      }
    }
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

  test("upgrades legacy default statusLineSegments to include state", async () => {
    const home = await createTempHome()
    const configDir = join(home, ".swiz")
    await mkdir(configDir, { recursive: true })
    await writeFile(
      join(configDir, "settings.json"),
      JSON.stringify({
        statusLineSegments: [
          "repo",
          "git",
          "pr",
          "model",
          "ctx",
          "backlog",
          "mode",
          "flags",
          "time",
        ],
      })
    )

    const settings = await readSwizSettings({ home })
    expect(settings.statusLineSegments).toEqual([...ALL_STATUS_LINE_SEGMENTS])
  })

  test("preserves custom statusLineSegments without forced state", async () => {
    const home = await createTempHome()
    const configDir = join(home, ".swiz")
    await mkdir(configDir, { recursive: true })
    await writeFile(
      join(configDir, "settings.json"),
      JSON.stringify({
        statusLineSegments: ["repo", "git", "time"],
      })
    )

    const settings = await readSwizSettings({ home })
    expect(settings.statusLineSegments).toEqual(["repo", "git", "time"])
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
      autoSteer: false,
      swizNotifyHooks: false,
      updateMemoryFooter: false,
      gitStatusGate: true,
      nonDefaultBranchGate: true,
      githubCiGate: true,
      ignoreCi: false,
      changesRequestedGate: true,
      personalRepoIssuesGate: true,
      issueCloseGate: false,
      qualityChecksGate: true,
      strictNoDirectMain: false,
      trunkMode: false,
      taskDurationWarningMinutes: 10,
      memoryLineThreshold: 1400,
      memoryWordThreshold: 5000,
      largeFileSizeKb: 500,
      dirtyWorktreeThreshold: 15,
      statusLineSegments: [...ALL_STATUS_LINE_SEGMENTS],
      sessions: {},
    }
    const effective = getEffectiveSwizSettings(settings)
    expect(effective.collaborationMode).toBe("solo")
  })

  test("getEffectiveSwizSettings forces githubCiGate off when ignoreCi is enabled", () => {
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
      autoSteer: false,
      swizNotifyHooks: false,
      updateMemoryFooter: false,
      gitStatusGate: true,
      nonDefaultBranchGate: true,
      githubCiGate: true,
      ignoreCi: true,
      changesRequestedGate: true,
      personalRepoIssuesGate: true,
      issueCloseGate: false,
      qualityChecksGate: true,
      strictNoDirectMain: false,
      trunkMode: false,
      taskDurationWarningMinutes: 10,
      memoryLineThreshold: 1400,
      memoryWordThreshold: 5000,
      largeFileSizeKb: 500,
      dirtyWorktreeThreshold: 15,
      statusLineSegments: [...ALL_STATUS_LINE_SEGMENTS],
      sessions: {},
    }
    const effective = getEffectiveSwizSettings(settings)
    expect(effective.ignoreCi).toBe(true)
    expect(effective.githubCiGate).toBe(false)
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
      autoSteer: false,
      swizNotifyHooks: false,
      updateMemoryFooter: false,
      gitStatusGate: true,
      nonDefaultBranchGate: true,
      githubCiGate: true,
      ignoreCi: false,
      changesRequestedGate: true,
      personalRepoIssuesGate: true,
      issueCloseGate: false,
      qualityChecksGate: true,
      strictNoDirectMain: false,
      trunkMode: false,
      taskDurationWarningMinutes: 10,
      memoryLineThreshold: 1400,
      memoryWordThreshold: 5000,
      largeFileSizeKb: 500,
      dirtyWorktreeThreshold: 15,
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
      autoSteer: false,
      swizNotifyHooks: false,
      updateMemoryFooter: false,
      gitStatusGate: true,
      nonDefaultBranchGate: true,
      githubCiGate: true,
      ignoreCi: false,
      changesRequestedGate: true,
      personalRepoIssuesGate: true,
      issueCloseGate: false,
      qualityChecksGate: true,
      strictNoDirectMain: false,
      trunkMode: false,
      taskDurationWarningMinutes: 10,
      memoryLineThreshold: 1400,
      memoryWordThreshold: 5000,
      largeFileSizeKb: 500,
      dirtyWorktreeThreshold: 15,
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
      autoSteer: false,
      swizNotifyHooks: false,
      updateMemoryFooter: false,
      gitStatusGate: true,
      nonDefaultBranchGate: true,
      githubCiGate: true,
      ignoreCi: false,
      changesRequestedGate: true,
      personalRepoIssuesGate: true,
      issueCloseGate: false,
      qualityChecksGate: true,
      strictNoDirectMain: false,
      trunkMode: false,
      taskDurationWarningMinutes: 10,
      memoryLineThreshold: 1400,
      memoryWordThreshold: 5000,
      largeFileSizeKb: 500,
      dirtyWorktreeThreshold: 15,
      statusLineSegments: [...ALL_STATUS_LINE_SEGMENTS],
      sessions: {},
    }
    const effective = getEffectiveSwizSettings(settings, null, { ambitionMode: "creative" })
    expect(effective.ambitionMode).toBe("creative")
  })

  test("project collaborationMode overrides global when no session override", () => {
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
      autoSteer: false,
      swizNotifyHooks: false,
      updateMemoryFooter: false,
      gitStatusGate: true,
      nonDefaultBranchGate: true,
      githubCiGate: true,
      ignoreCi: false,
      changesRequestedGate: true,
      personalRepoIssuesGate: true,
      issueCloseGate: false,
      qualityChecksGate: true,
      strictNoDirectMain: false,
      trunkMode: false,
      taskDurationWarningMinutes: 10,
      memoryLineThreshold: 1400,
      memoryWordThreshold: 5000,
      largeFileSizeKb: 500,
      dirtyWorktreeThreshold: 15,
      statusLineSegments: [...ALL_STATUS_LINE_SEGMENTS],
      sessions: {},
    }
    const effective = getEffectiveSwizSettings(settings, null, { collaborationMode: "team" })
    expect(effective.collaborationMode).toBe("team")
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
      autoSteer: false,
      swizNotifyHooks: false,
      updateMemoryFooter: false,
      gitStatusGate: true,
      nonDefaultBranchGate: true,
      githubCiGate: true,
      ignoreCi: false,
      changesRequestedGate: true,
      personalRepoIssuesGate: true,
      issueCloseGate: false,
      qualityChecksGate: true,
      strictNoDirectMain: false,
      trunkMode: false,
      taskDurationWarningMinutes: 10,
      memoryLineThreshold: 1400,
      memoryWordThreshold: 5000,
      largeFileSizeKb: 500,
      dirtyWorktreeThreshold: 15,
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

// ─── swizSettingsSchema constraint enforcement (regression for #184) ──────────
// These tests verify that readSwizSettings() enforces swizSettingsSchema bounds
// instead of the looser normalizeSettings() field-by-field checks.

describe("readSwizSettings schema constraint enforcement", () => {
  async function writeSettings(home: string, settings: Record<string, unknown>): Promise<void> {
    const configDir = join(home, ".swiz")
    await mkdir(configDir, { recursive: true })
    await writeFile(join(configDir, "settings.json"), JSON.stringify(settings))
  }

  test("narratorSpeed above 600 falls back to default", async () => {
    const home = await createTempHome()
    await writeSettings(home, { narratorSpeed: 999 })
    const settings = await readSwizSettings({ home })
    expect(settings.narratorSpeed).toBe(0) // DEFAULT_SETTINGS.narratorSpeed
  })

  test("narratorSpeed of 0 is accepted (boundary value)", async () => {
    const home = await createTempHome()
    await writeSettings(home, { narratorSpeed: 0 })
    const settings = await readSwizSettings({ home })
    expect(settings.narratorSpeed).toBe(0)
  })

  test("narratorSpeed of 600 is accepted (max boundary)", async () => {
    const home = await createTempHome()
    await writeSettings(home, { narratorSpeed: 600 })
    const settings = await readSwizSettings({ home })
    expect(settings.narratorSpeed).toBe(600)
  })

  test("prAgeGateMinutes non-integer falls back to default", async () => {
    const home = await createTempHome()
    await writeSettings(home, { prAgeGateMinutes: 2.5 })
    const settings = await readSwizSettings({ home })
    expect(settings.prAgeGateMinutes).toBe(10) // DEFAULT_SETTINGS.prAgeGateMinutes
  })

  test("pushCooldownMinutes non-integer falls back to default", async () => {
    const home = await createTempHome()
    await writeSettings(home, { pushCooldownMinutes: 1.2 })
    const settings = await readSwizSettings({ home })
    expect(settings.pushCooldownMinutes).toBe(0) // DEFAULT_SETTINGS.pushCooldownMinutes
  })

  test("disabledHooks with empty string entries falls back to undefined", async () => {
    const home = await createTempHome()
    await writeSettings(home, { disabledHooks: ["stop-github-ci.ts", ""] })
    const settings = await readSwizSettings({ home })
    // Empty string fails z.string().min(1) → entire disabledHooks falls back to undefined
    expect(settings.disabledHooks).toBeUndefined()
  })

  test("disabledHooks with all valid entries is accepted", async () => {
    const home = await createTempHome()
    await writeSettings(home, { disabledHooks: ["stop-github-ci.ts", "stop-git-status.ts"] })
    const settings = await readSwizSettings({ home })
    expect(settings.disabledHooks).toEqual(["stop-github-ci.ts", "stop-git-status.ts"])
  })

  test("memoryLineThreshold non-integer falls back to default", async () => {
    const home = await createTempHome()
    await writeSettings(home, { memoryLineThreshold: 1400.5 })
    const settings = await readSwizSettings({ home })
    expect(settings.memoryLineThreshold).toBe(1400) // DEFAULT_SETTINGS.memoryLineThreshold
  })

  test("memoryWordThreshold below minimum falls back to default", async () => {
    const home = await createTempHome()
    await writeSettings(home, { memoryWordThreshold: 0 })
    const settings = await readSwizSettings({ home })
    expect(settings.memoryWordThreshold).toBe(5000) // DEFAULT_SETTINGS.memoryWordThreshold
  })

  test("valid settings within all bounds are preserved exactly", async () => {
    const home = await createTempHome()
    await writeSettings(home, {
      narratorSpeed: 300,
      prAgeGateMinutes: 5,
      pushCooldownMinutes: 10,
      disabledHooks: ["stop-github-ci.ts"],
      pushGate: true,
    })
    const settings = await readSwizSettings({ home })
    expect(settings.narratorSpeed).toBe(300)
    expect(settings.prAgeGateMinutes).toBe(5)
    expect(settings.pushCooldownMinutes).toBe(10)
    expect(settings.disabledHooks).toEqual(["stop-github-ci.ts"])
    expect(settings.pushGate).toBe(true)
  })
})

// ─── strictNoDirectMain: enable/disable, conflict detection, --force ──────────

describe("strictNoDirectMain setting", () => {
  test("defaults to false", async () => {
    const home = await createTempHome()
    const settings = await readSwizSettings({ home })
    expect(settings.strictNoDirectMain).toBe(false)
  })

  test("enable and disable round-trip", async () => {
    const home = await createTempHome()
    const { exitCode: ec1 } = await runSwiz(
      ["settings", "enable", "strict-no-direct-main", "--force"],
      home
    )
    expect(ec1).toBe(0)
    const after = await readSwizSettings({ home })
    expect(after.strictNoDirectMain).toBe(true)

    const { exitCode: ec2 } = await runSwiz(["settings", "disable", "strict-no-direct-main"], home)
    expect(ec2).toBe(0)
    const final = await readSwizSettings({ home })
    expect(final.strictNoDirectMain).toBe(false)
  })

  test("accepts --project scope and writes strictNoDirectMain to project config", async () => {
    const home = await createTempHome()
    const { exitCode } = await runSwiz(
      ["settings", "enable", "strict-no-direct-main", "--project", "--dir", home, "--force"],
      home
    )
    expect(exitCode).toBe(0)
    const projectSettings = await readProjectSettings(home)
    expect(projectSettings?.strictNoDirectMain).toBe(true)
  })

  test("enable is blocked when collaborationMode=solo without --force", async () => {
    const home = await createTempHome()
    // Pre-set collaborationMode=solo
    await runSwiz(["settings", "set", "collaboration-mode", "solo"], home)
    const { exitCode, stderr } = await runSwiz(
      ["settings", "enable", "strict-no-direct-main"],
      home
    )
    expect(exitCode).not.toBe(0)
    expect(stderr).toContain("collaborationMode=solo")
    expect(stderr).toContain("--force")
    // Setting must remain disabled
    const settings = await readSwizSettings({ home })
    expect(settings.strictNoDirectMain).toBe(false)
  })

  test("enable is blocked when pushGate=false without --force", async () => {
    const home = await createTempHome()
    await runSwiz(["settings", "disable", "push-gate"], home)
    const { exitCode, stderr } = await runSwiz(
      ["settings", "enable", "strict-no-direct-main"],
      home
    )
    expect(exitCode).not.toBe(0)
    expect(stderr).toContain("pushGate=false")
    const settings = await readSwizSettings({ home })
    expect(settings.strictNoDirectMain).toBe(false)
  })

  test("enable is blocked when nonDefaultBranchGate=false without --force", async () => {
    const home = await createTempHome()
    await runSwiz(["settings", "disable", "non-default-branch-gate"], home)
    const { exitCode, stderr } = await runSwiz(
      ["settings", "enable", "strict-no-direct-main"],
      home
    )
    expect(exitCode).not.toBe(0)
    expect(stderr).toContain("nonDefaultBranchGate=false")
    const settings = await readSwizSettings({ home })
    expect(settings.strictNoDirectMain).toBe(false)
  })

  test("--force overrides conflicts and enables the setting", async () => {
    const home = await createTempHome()
    await runSwiz(["settings", "set", "collaboration-mode", "solo"], home)
    const { exitCode, stderr } = await runSwiz(
      ["settings", "enable", "strict-no-direct-main", "--force"],
      home
    )
    expect(exitCode).toBe(0)
    // Warning is emitted but the setting is written
    expect(stderr).toContain("Warning")
    const settings = await readSwizSettings({ home })
    expect(settings.strictNoDirectMain).toBe(true)
  })

  test("-f short flag is equivalent to --force", async () => {
    const home = await createTempHome()
    await runSwiz(["settings", "set", "collaboration-mode", "solo"], home)
    const { exitCode } = await runSwiz(["settings", "enable", "strict-no-direct-main", "-f"], home)
    expect(exitCode).toBe(0)
    const settings = await readSwizSettings({ home })
    expect(settings.strictNoDirectMain).toBe(true)
  })

  test("enable succeeds with no conflicts (auto mode, all gates enabled)", async () => {
    const home = await createTempHome()
    // pushGate defaults to false — enable it so no conflicts exist
    await runSwiz(["settings", "enable", "push-gate"], home)
    const { exitCode, stderr } = await runSwiz(
      ["settings", "enable", "strict-no-direct-main"],
      home
    )
    expect(exitCode).toBe(0)
    // No warning expected when there are no conflicts
    expect(stderr).not.toContain("Warning")
    const settings = await readSwizSettings({ home })
    expect(settings.strictNoDirectMain).toBe(true)
  })

  test("swiz settings show surfaces strict-no-direct-main", async () => {
    const home = await createTempHome()
    const { stdout } = await runSwiz(["settings", "show"], home)
    expect(stdout).toContain("strict-no-direct-main")
  })

  test("swiz settings show surfaces ignore-ci", async () => {
    const home = await createTempHome()
    const { stdout } = await runSwiz(["settings", "show"], home)
    expect(stdout).toContain("ignore-ci:")
  })

  test("swiz settings show reports project source for strict-no-direct-main", async () => {
    const home = await createTempHome()
    const { exitCode: setExitCode } = await runSwiz(
      ["settings", "enable", "strict-no-direct-main", "--project", "--dir", home, "--force"],
      home
    )
    expect(setExitCode).toBe(0)
    const { stdout } = await runSwiz(["settings", "show", "--project", "--dir", home], home)
    expect(stdout).toContain("strict-no-direct-main:   enabled (project override)")
  })

  test("getEffectiveSwizSettings propagates strictNoDirectMain", () => {
    const settings = {
      autoContinue: false,
      critiquesEnabled: false,
      ambitionMode: "standard" as const,
      collaborationMode: "auto" as const,
      narratorVoice: "",
      narratorSpeed: 0,
      prAgeGateMinutes: 10,
      prMergeMode: true,
      pushCooldownMinutes: 0,
      pushGate: true,
      sandboxedEdits: false,
      speak: false,
      autoSteer: false,
      swizNotifyHooks: false,
      updateMemoryFooter: false,
      gitStatusGate: true,
      nonDefaultBranchGate: true,
      githubCiGate: true,
      ignoreCi: false,
      changesRequestedGate: true,
      personalRepoIssuesGate: true,
      issueCloseGate: false,
      qualityChecksGate: true,
      strictNoDirectMain: true,
      trunkMode: false,
      taskDurationWarningMinutes: 10,
      memoryLineThreshold: 1400,
      memoryWordThreshold: 5000,
      largeFileSizeKb: 500,
      dirtyWorktreeThreshold: 15,
      statusLineSegments: [...ALL_STATUS_LINE_SEGMENTS],
      sessions: {},
    }
    const effective = getEffectiveSwizSettings(settings)
    expect(effective.strictNoDirectMain).toBe(true)
  })

  test("getEffectiveSwizSettings applies project strictNoDirectMain override", () => {
    const settings = {
      autoContinue: false,
      critiquesEnabled: false,
      ambitionMode: "standard" as const,
      collaborationMode: "auto" as const,
      narratorVoice: "",
      narratorSpeed: 0,
      prAgeGateMinutes: 10,
      prMergeMode: true,
      pushCooldownMinutes: 0,
      pushGate: true,
      sandboxedEdits: false,
      speak: false,
      autoSteer: false,
      swizNotifyHooks: false,
      updateMemoryFooter: false,
      gitStatusGate: true,
      nonDefaultBranchGate: true,
      githubCiGate: true,
      ignoreCi: false,
      changesRequestedGate: true,
      personalRepoIssuesGate: true,
      issueCloseGate: false,
      qualityChecksGate: true,
      strictNoDirectMain: false,
      trunkMode: false,
      taskDurationWarningMinutes: 10,
      memoryLineThreshold: 1400,
      memoryWordThreshold: 5000,
      largeFileSizeKb: 500,
      dirtyWorktreeThreshold: 15,
      statusLineSegments: [...ALL_STATUS_LINE_SEGMENTS],
      sessions: {},
    }
    const effective = getEffectiveSwizSettings(settings, null, { strictNoDirectMain: true })
    expect(effective.strictNoDirectMain).toBe(true)
  })
})
