import { beforeAll, describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { AGENTS } from "../agents.ts"
import { hookIdentifier, isInlineHookDef, manifest } from "../manifest.ts"
import { useTempDir } from "../utils/test-utils.ts"

const { create: createTempHome } = useTempDir("swiz-doctor-test-")

const INDEX_PATH = join(process.cwd(), "index.ts")

type DoctorResult = { stdout: string; stderr: string; exitCode: number | null }

async function runDoctor(
  home: string,
  args: string[] = [],
  cwd: string = process.cwd()
): Promise<DoctorResult> {
  const proc = Bun.spawn(["bun", "run", INDEX_PATH, "doctor", ...args], {
    cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HOME: home },
  })
  void proc.stdin.end()
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited
  return { stdout, stderr, exitCode: proc.exitCode }
}

async function createSkill(home: string, relativeRoot: string, skillName: string): Promise<void> {
  const skillDir = join(home, relativeRoot, skillName)
  await mkdir(skillDir, { recursive: true })
  await writeFile(
    join(skillDir, "SKILL.md"),
    `---\nname: ${skillName}\ndescription: test skill\ncategory: testing\n---\n`
  )
}

function buildExpectedHooks() {
  const claudeAgent = AGENTS.find((a) => a.id === "claude")!
  const events = [...new Set(manifest.filter((g) => !g.scheduled).map((g) => g.event))]
  const hooks: Record<string, Array<{ hooks: Array<{ type: string; command: string }> }>> = {}
  for (const event of events) {
    const agentEvent = claudeAgent.eventMap[event] ?? event
    hooks[agentEvent] = [
      {
        hooks: [
          {
            type: "command",
            command: `command -v swiz >/dev/null 2>&1 || exit 0; swiz dispatch ${event} ${agentEvent}`,
          },
        ],
      },
    ]
  }
  return hooks
}

describe("swiz doctor", () => {
  // ── Clean-home tests: share a single subprocess call ──────────────────
  describe("clean home checks", () => {
    let result: DoctorResult

    beforeAll(async () => {
      const home = await createTempHome()
      result = await runDoctor(home)
    })

    test("reports Bun runtime as passing", () => {
      expect(result.stdout).toContain("Bun runtime")
      expect(result.stdout).toMatch(/Bun runtime.*v\d+/)
    })

    test("reports hook scripts check", () => {
      expect(result.stdout).toContain("Hook scripts")
      expect(result.stdout).toMatch(/Hook scripts.*manifest scripts found/)
    })

    test("reports manifest handler paths as valid in a healthy install", () => {
      expect(result.stdout).toContain("Manifest handler paths")
      // Check for either the positive summary or the "no handler files" message
      expect(result.stdout).toMatch(
        /Manifest handler paths.*(handler paths valid|no handler files in manifest)/
      )
    })

    test("reports orphaned hook scripts check", () => {
      expect(result.stdout).toContain("Orphaned hook scripts")
      expect(result.stdout).toMatch(/Orphaned hook scripts/)
    })

    test("reports script execute permissions check", () => {
      expect(result.stdout).toContain("Script execute permissions")
      expect(result.stdout).toMatch(/Script execute permissions/)
    })

    test("reports installed config scripts check", () => {
      expect(result.stdout).toContain("Installed config scripts")
    })

    test("installed config scripts check includes manifest scripts in scope", () => {
      // In tests, we might be running with a sparse manifest if hooks/ is empty
      const manifestScriptCount = new Set(
        manifest.flatMap((g) =>
          g.hooks.flatMap((h) => (isInlineHookDef(h) ? [] : [hookIdentifier(h)]))
        )
      ).size
      const match = result.stdout.match(/all (\d+) executable scripts are present/)
      if (match) {
        const count = parseInt(match[1]!, 10)
        expect(count).toBeGreaterThanOrEqual(manifestScriptCount)
      } else {
        expect(result.stdout).toContain("all 0 executable scripts are present")
      }
    })

    test("reports GitHub CLI auth status", () => {
      expect(result.stdout).toContain("GitHub CLI auth")
    })

    test("reports TTS backend status", () => {
      expect(result.stdout).toContain("TTS backend")
    })

    test("reports swiz settings status", () => {
      expect(result.stdout).toContain("Swiz settings")
    })

    test("shows summary counts", () => {
      expect(result.stdout).toMatch(/\d+ passed/)
    })

    test("exits zero when no hard failures", () => {
      if (!result.stdout.includes("failed")) {
        expect(result.exitCode).toBe(0)
      }
    })

    test("reports agent binary checks for all agents", () => {
      expect(result.stdout).toContain("Claude Code binary")
      expect(result.stdout).toContain("Cursor binary")
      expect(result.stdout).toContain("Gemini CLI binary")
      expect(result.stdout).toContain("Codex CLI binary")
    })

    test("reports config sync check for configurable agents", () => {
      expect(result.stdout).toContain("config sync")
    })

    test("reports no orphaned hook scripts in a healthy install", () => {
      expect(result.stdout).toContain("Orphaned hook scripts")
      expect(result.stdout).toContain("no orphaned scripts found")
    })

    test("reports no invalid skill entries in a healthy install", () => {
      expect(result.stdout).toContain("Invalid skill entries")
      expect(result.stdout).toContain("no invalid skill entries found")
    })
  })

  describe("orphaned hook manifest paths (#479)", () => {
    test("fixOrphanedHookScripts resolves manifest and hooks from package root, not cwd", async () => {
      const doctorSrc = await Bun.file(join(import.meta.dir, "doctor.ts")).text()
      const start = doctorSrc.indexOf("async function fixOrphanedHookScripts")
      expect(start).toBeGreaterThanOrEqual(0)
      const block = doctorSrc.slice(start, start + 4000)
      expect(block).toContain('join(SWIZ_ROOT, "src", "manifest.ts")')
      expect(block).toContain("join(HOOKS_DIR, script)")
      expect(block).not.toContain('join(process.cwd(), "src", "manifest.ts")')
      expect(block).not.toContain('join(process.cwd(), "hooks", script)')
    })
  })

  // ── Tests requiring custom settings.json ──────────────────────────────

  test("doctor --fix sets execute permissions on scripts in installed config", async () => {
    const home = await createTempHome()
    const claudeDir = join(home, ".claude")
    await mkdir(claudeDir, { recursive: true })
    const scriptPath = join(home, "test-hook.ts")
    await writeFile(scriptPath, "#!/usr/bin/env bun\nconsole.log('test')\n", { mode: 0o644 })
    await writeFile(
      join(claudeDir, "settings.json"),
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: "command", command: `bun ${scriptPath}` }] }],
        },
      })
    )
    const fixRun = await runDoctor(home, ["--fix"])
    expect(fixRun.stdout).toContain("Script execute permissions")
    const { stat: statFn } = await import("node:fs/promises")
    const s = await statFn(scriptPath)
    expect(s.mode & 0o100).not.toBe(0)
  }, 60_000)

  // ── Missing/invalid config script detection: share one home ───────────
  // ── Config script detection + malformed settings + config sync ──────
  // These tests each need custom settings.json but are independent,
  // so run them concurrently via Promise.all within batched tests.

  test("detects missing/invalid config scripts in various formats", async () => {
    type Case = {
      label: string
      settings: unknown
      expectContains: string[]
      expectNotContains?: string[]
      setupExtra?: (home: string) => Promise<void>
    }
    const cases: Case[] = [
      {
        label: "source attribution",
        settings: {
          hooks: {
            Stop: [
              { hooks: [{ type: "command", command: "bun /nonexistent/config-only-hook.ts" }] },
            ],
          },
        },
        expectContains: ["/nonexistent/config-only-hook.ts", "(config)"],
      },
      {
        label: "missing script in hook config",
        settings: {
          hooks: {
            Stop: [{ hooks: [{ type: "command", command: "bun /nonexistent/path/to/hook.ts" }] }],
          },
        },
        expectContains: ["Installed config scripts", "/nonexistent/path/to/hook.ts"],
      },
      {
        label: "nested hook config",
        settings: {
          hooks: {
            PreToolUse: [
              {
                matcher: "Bash",
                hooks: [{ hooks: [{ type: "command", command: "bun /deeply/nested/hook.ts" }] }],
              },
            ],
          },
        },
        expectContains: ["Installed config scripts", "/deeply/nested/hook.ts"],
      },
      {
        label: "quoted path with spaces",
        settings: {
          hooks: {
            Stop: [{ hooks: [{ type: "command", command: 'bun "/path with spaces/my hook.ts"' }] }],
          },
        },
        expectContains: ["Installed config scripts", "/path with spaces/my hook.ts"],
      },
      {
        label: "scripts key",
        settings: {
          hooks: { Stop: [{ scripts: "bun /from/scripts/key/hook.ts" }] },
        },
        expectContains: ["Installed config scripts", "/from/scripts/key/hook.ts"],
      },
      {
        label: "run key",
        settings: {
          hooks: { Stop: [{ run: "bun /from/run/key/hook.ts" }] },
        },
        expectContains: ["Installed config scripts", "/from/run/key/hook.ts"],
      },
      {
        label: "args array",
        settings: {
          hooks: { Stop: [{ args: ["bun", "/from/args/array/hook.ts"] }] },
        },
        expectContains: ["Installed config scripts", "/from/args/array/hook.ts"],
      },
    ]
    await Promise.all(
      cases.map(async ({ settings, expectContains }) => {
        const h = await createTempHome()
        const claudeDir = join(h, ".claude")
        await mkdir(claudeDir, { recursive: true })
        await writeFile(join(claudeDir, "settings.json"), JSON.stringify(settings))
        const result = await runDoctor(h)
        for (const text of expectContains) {
          expect(result.stdout).toContain(text)
        }
      })
    )
  }, 60_000)

  test("detects non-executable script referenced in installed hook config", async () => {
    const h = await createTempHome()
    const claudeDir = join(h, ".claude")
    await mkdir(claudeDir, { recursive: true })
    const scriptPath = join(h, "non-exec-hook.ts")
    await writeFile(scriptPath, "#!/usr/bin/env bun\n", { mode: 0o644 })
    await writeFile(
      join(claudeDir, "settings.json"),
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: "command", command: `bun ${scriptPath}` }] }],
        },
      })
    )
    const result = await runDoctor(h)
    expect(result.stdout).toContain("Installed config scripts")
    expect(result.stdout).toContain("not executable")
    expect(result.stdout).toContain(scriptPath)
  }, 60_000)

  // ── Malformed settings + config sync: run concurrently ────────────────

  test("malformed settings and config sync checks", async () => {
    const [malformedHome, failureHome, missingDispatchHome, syncHome, staleHome] =
      await Promise.all([
        createTempHome(),
        createTempHome(),
        createTempHome(),
        createTempHome(),
        createTempHome(),
      ])

    // Setup all homes concurrently
    await Promise.all([
      (async () => {
        await mkdir(join(malformedHome, ".claude"), { recursive: true })
        await writeFile(join(malformedHome, ".claude", "settings.json"), "{ invalid json !!!")
      })(),
      (async () => {
        await mkdir(join(failureHome, ".claude"), { recursive: true })
        await writeFile(join(failureHome, ".claude", "settings.json"), "not json at all")
      })(),
      (async () => {
        await mkdir(join(missingDispatchHome, ".claude"), { recursive: true })
        await writeFile(
          join(missingDispatchHome, ".claude", "settings.json"),
          JSON.stringify({
            hooks: {
              Stop: [{ hooks: [{ type: "command", command: "echo hello" }] }],
            },
          })
        )
      })(),
      (async () => {
        await mkdir(join(syncHome, ".claude"), { recursive: true })
        await writeFile(
          join(syncHome, ".claude", "settings.json"),
          JSON.stringify({ hooks: buildExpectedHooks() })
        )
      })(),
      (async () => {
        await mkdir(join(staleHome, ".claude"), { recursive: true })
        await writeFile(join(staleHome, ".claude", "settings.json"), JSON.stringify({ hooks: {} }))
      })(),
    ])

    // Run all doctors concurrently
    const [malformed, failure, missingDispatch, sync, stale] = await Promise.all([
      runDoctor(malformedHome),
      runDoctor(failureHome),
      runDoctor(missingDispatchHome),
      runDoctor(syncHome),
      runDoctor(staleHome),
    ])

    // Malformed JSON detection
    expect(malformed.stdout).toContain("Claude Code settings")
    expect(malformed.stdout).toContain("malformed JSON")

    // Non-zero exit on failure
    expect(failure.exitCode).not.toBe(0)
    expect(failure.stderr).toContain("check(s) failed")

    // Missing dispatch entries
    expect(missingDispatch.stdout).toContain("Claude Code config sync")
    expect(missingDispatch.stdout).toContain("missing dispatch")

    // Dispatch entries in sync
    expect(sync.stdout).toContain("Claude Code config sync")
    expect(sync.stdout).toContain("dispatch entries in sync")

    // Stale config with fix hint
    expect(stale.stdout).toContain("missing dispatch")
    expect(stale.stdout).toContain("swiz install")
  }, 60_000)

  // ── Skill conflict tests ──────────────────────────────────────────────

  test("reports duplicate skill-name conflicts with active and overridden paths", async () => {
    const home = await createTempHome()
    const skillName = `doctor-dup-${Date.now()}`
    await createSkill(home, ".gemini/skills", skillName)
    await createSkill(home, ".codex/skills", skillName)

    const result = await runDoctor(home)
    expect(result.stdout).toContain(`Skill conflict: ${skillName}`)
    expect(result.stdout).toContain(`~/.gemini/skills/${skillName}/SKILL.md`)
    expect(result.stdout).toContain(`~/.codex/skills/${skillName}/SKILL.md`)
    expect(result.stdout).toContain("precedence=")
  }, 60_000)

  // ── Skill validation: concurrent batch of read-only checks ──────────
  test("detects invalid skill entries (frontmatter/category issues)", async () => {
    type SkillCase = {
      skillName: string
      skillPath: string
      content?: string
      expectContains: string[]
      expectNotContains?: string[]
    }
    const cases: SkillCase[] = [
      {
        skillName: "broken-skill",
        skillPath: ".claude/skills/broken-skill",
        // No SKILL.md created — just the directory
        expectContains: ["Invalid skill: broken-skill", "missing SKILL.md"],
      },
      {
        skillName: "no-desc-skill",
        skillPath: ".claude/skills/no-desc-skill",
        content: "---\nname: no-desc-skill\n---\n\nNo description field.\n",
        expectContains: [
          "Invalid skill: no-desc-skill",
          "missing required frontmatter field(s): description",
        ],
      },
      {
        skillName: "no-name-skill",
        skillPath: ".claude/skills/no-name-skill",
        content: "---\ndescription: Has description but no name field\n---\n\nContent.\n",
        expectContains: [
          "Invalid skill: no-name-skill",
          "missing required frontmatter field(s): name",
        ],
      },
      {
        skillName: "empty-fm-skill",
        skillPath: ".claude/skills/empty-fm-skill",
        content: "---\n---\n\nFrontmatter exists but has no fields.\n",
        expectContains: [
          "Invalid skill: empty-fm-skill",
          "missing required frontmatter field(s): name, description",
        ],
      },
      {
        skillName: "no-fm-skill",
        skillPath: ".claude/skills/no-fm-skill",
        content: "# Just a heading\n\nNo frontmatter at all.\n",
        expectContains: ["Invalid skill: no-fm-skill", "no frontmatter block"],
      },
      {
        skillName: "placeholder-skill",
        skillPath: ".claude/skills/placeholder-skill",
        content:
          "---\nname: placeholder-skill\ndescription: Add a description for this skill.\n---\n",
        expectContains: [
          "Invalid skill: placeholder-skill",
          "description is the generated placeholder",
        ],
      },
      {
        skillName: "no-category-skill",
        skillPath: ".claude/skills/no-category-skill",
        content: "---\nname: no-category-skill\ndescription: Does something useful.\n---\n",
        expectContains: ["Invalid skill: no-category-skill", "missing category field"],
      },
      {
        skillName: "bad-cat-skill",
        skillPath: ".claude/skills/bad-cat-skill",
        content:
          "---\nname: bad-cat-skill\ndescription: Does something useful.\ncategory: not-a-real-category\n---\n",
        expectContains: ["Invalid skill: bad-cat-skill", 'unknown category "not-a-real-category"'],
      },
      {
        skillName: "typo-cat-skill",
        skillPath: ".claude/skills/typo-cat-skill",
        content:
          "---\nname: typo-cat-skill\ndescription: Does something useful.\ncategory: tesing\n---\n",
        expectContains: [
          "Invalid skill: typo-cat-skill",
          'unknown category "tesing"',
          'did you mean: "testing"',
        ],
      },
      {
        skillName: "far-cat-skill",
        skillPath: ".claude/skills/far-cat-skill",
        content:
          "---\nname: far-cat-skill\ndescription: Does something useful.\ncategory: zzzzzzzzzzzz\n---\n",
        expectContains: ["Invalid skill: far-cat-skill"],
        expectNotContains: ["did you mean"],
      },
    ]

    await Promise.all(
      cases.map(async ({ skillPath, content, expectContains, expectNotContains }) => {
        const home = await createTempHome()
        const skillDir = join(home, skillPath)
        await mkdir(skillDir, { recursive: true })
        if (content) {
          await writeFile(join(skillDir, "SKILL.md"), content)
        }
        const result = await runDoctor(home)
        for (const text of expectContains) {
          expect(result.stdout).toContain(text)
        }
        for (const text of expectNotContains ?? []) {
          expect(result.stdout).not.toContain(text)
        }
      })
    )
  }, 60_000)

  test("skill validation edge cases", async () => {
    // Run concurrently: real description OK, name mismatch + placeholder, name mismatch,
    // quoted name match, dotdir ignore
    const homes = await Promise.all(Array.from({ length: 5 }, () => createTempHome()))
    const [realHome, bothHome, mismatchHome, quotedHome, dotdirHome] = homes as [
      string,
      string,
      string,
      string,
      string,
    ]

    // Setup all concurrently
    await Promise.all([
      (async () => {
        const d = join(realHome, ".claude", "skills", "real-skill")
        await mkdir(d, { recursive: true })
        await writeFile(
          join(d, "SKILL.md"),
          "---\nname: real-skill\ndescription: Does something useful.\ncategory: productivity\n---\n"
        )
      })(),
      (async () => {
        const d = join(bothHome, ".claude", "skills", "my-skill")
        await mkdir(d, { recursive: true })
        await writeFile(
          join(d, "SKILL.md"),
          "---\nname: wrong-name\ndescription: Add a description for this skill.\n---\n"
        )
      })(),
      (async () => {
        const d = join(mismatchHome, ".claude", "skills", "my-skill")
        await mkdir(d, { recursive: true })
        await writeFile(
          join(d, "SKILL.md"),
          "---\nname: different-name\ndescription: test skill\n---\n"
        )
      })(),
      (async () => {
        const d = join(quotedHome, ".claude", "skills", "quoted-skill")
        await mkdir(d, { recursive: true })
        await writeFile(
          join(d, "SKILL.md"),
          '---\nname: "quoted-skill"\ndescription: test skill\ncategory: testing\n---\n'
        )
      })(),
      (async () => {
        const d = join(dotdirHome, ".claude", "skills", ".unison.solid-analysis.abc123.unison.tmp")
        await mkdir(d, { recursive: true })
      })(),
    ])

    // Run all doctors concurrently
    const [real, both, mismatch, quoted, dotdir] = await Promise.all([
      runDoctor(realHome),
      runDoctor(bothHome),
      runDoctor(mismatchHome),
      runDoctor(quotedHome),
      runDoctor(dotdirHome),
    ])

    // Real description should not be flagged
    expect(real.stdout).not.toContain("Invalid skill: real-skill")

    // Both errors reported together
    expect(both.stdout).toContain(
      'frontmatter name "wrong-name" does not match directory name "my-skill"'
    )
    expect(both.stdout).toContain("description is the generated placeholder")

    // Name mismatch detected
    expect(mismatch.stdout).toContain("Invalid skill: my-skill")
    expect(mismatch.stdout).toContain(
      'frontmatter name "different-name" does not match directory name "my-skill"'
    )

    // Quoted name matching directory name is OK
    expect(quoted.stdout).not.toContain("Invalid skill: quoted-skill")

    // Dotdirectory ignored
    expect(dotdir.stdout).not.toContain("Invalid skill: .unison")
    expect(dotdir.stdout).toContain("no invalid skill entries found")
  }, 60_000)

  test("project allowedSkillCategories overrides default allowed list", async () => {
    const home = await createTempHome()
    const projectRoot = await createTempHome()
    const skillDir = join(home, ".claude", "skills", "custom-cat-skill")
    await mkdir(skillDir, { recursive: true })
    await writeFile(
      join(skillDir, "SKILL.md"),
      "---\nname: custom-cat-skill\ndescription: Does something useful.\ncategory: my-custom-category\n---\n"
    )
    const swizDir = join(projectRoot, ".swiz")
    await mkdir(swizDir, { recursive: true })
    await writeFile(
      join(swizDir, "config.json"),
      JSON.stringify({ allowedSkillCategories: ["my-custom-category"] })
    )
    const result = await runDoctor(home, [], projectRoot)
    expect(result.stdout).not.toContain("Invalid skill: custom-cat-skill")
  }, 60_000)

  // ── Skill --fix tests ─────────────────────────────────────────────────

  test("doctor --fix creates stub for missing config script", async () => {
    const home = await createTempHome()
    const claudeDir = join(home, ".claude")
    await mkdir(claudeDir, { recursive: true })
    const missingPath = join(home, "my-hook.ts")
    await writeFile(
      join(claudeDir, "settings.json"),
      JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: "command", command: `bun ${missingPath}` }] }] },
      })
    )
    const fixRun = await runDoctor(home, ["--fix"])
    expect(fixRun.stdout).toContain("Registering missing config scripts")
    expect(await Bun.file(missingPath).exists()).toBe(true)
    const content = await Bun.file(missingPath).text()
    expect(content).toContain("#!/usr/bin/env bun")
  }, 60_000)

  test("doctor --fix reports unfixable invalid skill entries but does not auto-disable", async () => {
    const home = await createTempHome()
    const skillsDir = join(home, ".claude", "skills")
    const skillName = `invalid-skill-${Date.now()}`
    const skillDir = join(skillsDir, skillName)
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, "SKILL.md"), "")

    const fixRun = await runDoctor(home, ["--fix"])
    expect(fixRun.stdout).toContain("Auto-fixing invalid skill entries")
    // Empty SKILL.md can't be auto-fixed — but directory stays in place
    expect(await Bun.file(join(skillDir, "SKILL.md")).exists()).toBe(true)
    expect(fixRun.stdout).toContain("could not fix")
  }, 60_000)

  test("doctor --fix generates default SKILL.md for skill directory missing one", async () => {
    const home = await createTempHome()
    const skillsDir = join(home, ".claude", "skills")
    const skillName = `new-skill-${Date.now()}`
    const skillDir = join(skillsDir, skillName)
    await mkdir(skillDir, { recursive: true })

    const fixRun = await runDoctor(home, ["--fix"])
    expect(fixRun.stdout).toContain("Auto-fixing invalid skill entries")
    expect(fixRun.stdout).toContain("generated default")
    expect(fixRun.stdout).toContain(skillName)

    const { stat: statFn } = await import("node:fs/promises")
    const dirStat = await statFn(skillDir)
    expect(dirStat.isDirectory()).toBe(true)

    const skillMdPath = join(skillDir, "SKILL.md")
    expect(await Bun.file(skillMdPath).exists()).toBe(true)
    const content = await Bun.file(skillMdPath).text()
    expect(content).toContain(`name: ${skillName}`)
    expect(content).toContain("description:")
    expect(content).toMatch(/^---/m)

    const afterFix = await runDoctor(home)
    expect(afterFix.stdout).not.toContain("missing SKILL.md")
  }, 60_000)

  test("doctor --fix updates frontmatter name to match directory name", async () => {
    const home = await createTempHome()
    const skillDir = join(home, ".claude", "skills", "my-skill")
    await mkdir(skillDir, { recursive: true })
    const skillMdPath = join(skillDir, "SKILL.md")
    await writeFile(
      skillMdPath,
      "---\nname: wrong-name\ndescription: test skill\ncategory: testing\n---\n"
    )

    const fixRun = await runDoctor(home, ["--fix"])
    expect(fixRun.stdout).toContain("Auto-fixing invalid skill entries")
    expect(fixRun.stdout).toContain('updated name "wrong-name" → "my-skill"')

    expect(await Bun.file(skillMdPath).exists()).toBe(true)
    const content = await Bun.file(skillMdPath).text()
    expect(content).toContain("name: my-skill")
    expect(content).not.toContain("wrong-name")

    const afterFix = await runDoctor(home)
    expect(afterFix.stdout).not.toContain("Invalid skill: my-skill")
  }, 60_000)

  test("doctor --fix updates quoted frontmatter name to match directory name", async () => {
    const home = await createTempHome()
    const skillDir = join(home, ".claude", "skills", "target-skill")
    await mkdir(skillDir, { recursive: true })
    const skillMdPath = join(skillDir, "SKILL.md")
    await writeFile(skillMdPath, '---\nname: "quoted-wrong"\ndescription: test skill\n---\n')

    await runDoctor(home, ["--fix"])

    const content = await Bun.file(skillMdPath).text()
    expect(content).toContain("name: target-skill")
    expect(content).not.toContain("quoted-wrong")
  }, 60_000)

  test("doctor --fix generated stub then warns placeholder on re-run", async () => {
    const home = await createTempHome()
    const skillDir = join(home, ".claude", "skills", "stub-skill")
    await mkdir(skillDir, { recursive: true })

    await runDoctor(home, ["--fix"])

    const afterFix = await runDoctor(home)
    expect(afterFix.stdout).toContain("Invalid skill: stub-skill")
    expect(afterFix.stdout).toContain("description is the generated placeholder")
  }, 60_000)

  test("doctor --fix replaces unknown category value with default", async () => {
    const home = await createTempHome()
    const skillsDir = join(home, ".claude", "skills")
    const skillDir = join(skillsDir, "bad-cat-fix-skill")
    const skillMdPath = join(skillDir, "SKILL.md")
    await mkdir(skillDir, { recursive: true })
    await writeFile(
      skillMdPath,
      "---\nname: bad-cat-fix-skill\ndescription: Does something useful.\ncategory: totally-invalid\n---\n"
    )

    const fixRun = await runDoctor(home, ["--fix"])
    expect(fixRun.stdout).toContain("Auto-fixing invalid skill entries")
    expect(fixRun.stdout).toContain("bad-cat-fix-skill")
    expect(fixRun.stdout).toContain('added category "uncategorized"')

    const { stat: statFn } = await import("node:fs/promises")
    const dirStat = await statFn(skillDir)
    expect(dirStat.isDirectory()).toBe(true)

    const content = await Bun.file(skillMdPath).text()
    expect(content).toContain("category: uncategorized")
    expect(content).not.toContain("totally-invalid")

    const afterFix = await runDoctor(home)
    expect(afterFix.stdout).not.toContain("Invalid skill: bad-cat-fix-skill")
  }, 60_000)

  test("doctor --fix adds default category to skill missing one", async () => {
    const home = await createTempHome()
    const skillsDir = join(home, ".claude", "skills")
    const skillDir = join(skillsDir, "no-cat-skill")
    const skillMdPath = join(skillDir, "SKILL.md")
    await mkdir(skillDir, { recursive: true })
    await writeFile(
      skillMdPath,
      "---\nname: no-cat-skill\ndescription: Does something useful.\n---\n"
    )

    const fixRun = await runDoctor(home, ["--fix"])
    expect(fixRun.stdout).toContain("Auto-fixing invalid skill entries")
    expect(fixRun.stdout).toContain("no-cat-skill")
    expect(fixRun.stdout).toContain('added category "uncategorized"')

    const { stat: statFn } = await import("node:fs/promises")
    const dirStat = await statFn(skillDir)
    expect(dirStat.isDirectory()).toBe(true)

    const content = await Bun.file(skillMdPath).text()
    expect(content).toContain("category: uncategorized")

    const afterFix = await runDoctor(home)
    expect(afterFix.stdout).not.toContain("Invalid skill: no-cat-skill")
  }, 60_000)
})
