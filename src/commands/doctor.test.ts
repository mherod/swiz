import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AGENTS } from "../agents.ts"
import { manifest } from "../manifest.ts"

const tempDirs: string[] = []

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (!dir) continue
    await rm(dir, { recursive: true, force: true })
  }
})

async function createTempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "swiz-doctor-test-"))
  tempDirs.push(dir)
  return dir
}

async function runDoctor(
  home: string,
  args: string[] = []
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const proc = Bun.spawn(["bun", "run", "index.ts", "doctor", ...args], {
    cwd: process.cwd(),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HOME: home },
  })
  proc.stdin.end()
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
    `---\nname: ${skillName}\ndescription: test skill\n---\n`
  )
}

function buildExpectedHooks() {
  const claudeAgent = AGENTS.find((a) => a.id === "claude")!
  const events = [...new Set(manifest.map((g) => g.event))]
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
  test("reports Bun runtime as passing", async () => {
    const home = await createTempHome()
    const result = await runDoctor(home)
    expect(result.stdout).toContain("Bun runtime")
    expect(result.stdout).toMatch(/Bun runtime.*v\d+/)
  })

  test("reports hook scripts check", async () => {
    const home = await createTempHome()
    const result = await runDoctor(home)
    expect(result.stdout).toContain("Hook scripts")
    // All manifest scripts should exist in the repo
    expect(result.stdout).toMatch(/Hook scripts.*manifest scripts found/)
  })

  test("reports manifest handler paths as valid in a healthy install", async () => {
    const home = await createTempHome()
    const result = await runDoctor(home)
    expect(result.stdout).toContain("Manifest handler paths")
    expect(result.stdout).toMatch(/Manifest handler paths.*handler paths valid/)
  })

  test("reports orphaned hook scripts check", async () => {
    const home = await createTempHome()
    const result = await runDoctor(home)
    expect(result.stdout).toContain("Orphaned hook scripts")
    // The check runs and reports either pass or the list of orphaned scripts
    expect(result.stdout).toMatch(/Orphaned hook scripts/)
  })

  test("reports script execute permissions check", async () => {
    const home = await createTempHome()
    const result = await runDoctor(home)
    expect(result.stdout).toContain("Script execute permissions")
    // Reports either pass or a warning about missing execute bits
    expect(result.stdout).toMatch(/Script execute permissions/)
  })

  test("doctor --fix sets execute permissions on scripts in installed config", async () => {
    const home = await createTempHome()
    const claudeDir = join(home, ".claude")
    await mkdir(claudeDir, { recursive: true })
    // Create a script file without execute permission
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
    // After fix, the file should have execute permission
    const { stat: statFn } = await import("node:fs/promises")
    const s = await statFn(scriptPath)
    expect(s.mode & 0o100).not.toBe(0)
  })

  test("reports installed config scripts check", async () => {
    const home = await createTempHome()
    const result = await runDoctor(home)
    expect(result.stdout).toContain("Installed config scripts")
  })

  test("installed config scripts check includes manifest scripts in scope", async () => {
    const home = await createTempHome()
    const result = await runDoctor(home)
    // The check covers manifest + config scripts; count must be >= manifest script count
    const manifestScriptCount = new Set(manifest.flatMap((g) => g.hooks.map((h) => h.file))).size
    const match = result.stdout.match(/all (\d+) executable scripts are present/)
    expect(match).not.toBeNull()
    const count = parseInt(match![1]!, 10)
    expect(count).toBeGreaterThanOrEqual(manifestScriptCount)
  })

  test("labels missing config script with source attribution", async () => {
    const home = await createTempHome()
    const claudeDir = join(home, ".claude")
    await mkdir(claudeDir, { recursive: true })
    await writeFile(
      join(claudeDir, "settings.json"),
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: "command", command: "bun /nonexistent/config-only-hook.ts" }] }],
        },
      })
    )
    const result = await runDoctor(home)
    expect(result.stdout).toContain("/nonexistent/config-only-hook.ts")
    expect(result.stdout).toContain("(config)")
  })

  test("detects missing script referenced in installed hook config", async () => {
    const home = await createTempHome()
    const claudeDir = join(home, ".claude")
    await mkdir(claudeDir, { recursive: true })
    await writeFile(
      join(claudeDir, "settings.json"),
      JSON.stringify({
        hooks: {
          Stop: [
            {
              hooks: [
                {
                  type: "command",
                  command: "bun /nonexistent/path/to/hook.ts",
                },
              ],
            },
          ],
        },
      })
    )
    const result = await runDoctor(home)
    expect(result.stdout).toContain("Installed config scripts")
    expect(result.stdout).toContain("/nonexistent/path/to/hook.ts")
  })

  test("detects missing script at arbitrary nesting depth in hook config", async () => {
    const home = await createTempHome()
    const claudeDir = join(home, ".claude")
    await mkdir(claudeDir, { recursive: true })
    // Three levels of nesting: hooks -> matchers -> hooks -> command
    await writeFile(
      join(claudeDir, "settings.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [
                {
                  hooks: [
                    {
                      type: "command",
                      command: "bun /deeply/nested/hook.ts",
                    },
                  ],
                },
              ],
            },
          ],
        },
      })
    )
    const result = await runDoctor(home)
    expect(result.stdout).toContain("Installed config scripts")
    expect(result.stdout).toContain("/deeply/nested/hook.ts")
  })

  test("detects missing script with quoted path containing spaces", async () => {
    const home = await createTempHome()
    const claudeDir = join(home, ".claude")
    await mkdir(claudeDir, { recursive: true })
    await writeFile(
      join(claudeDir, "settings.json"),
      JSON.stringify({
        hooks: {
          Stop: [
            {
              hooks: [
                {
                  type: "command",
                  command: 'bun "/path with spaces/my hook.ts"',
                },
              ],
            },
          ],
        },
      })
    )
    const result = await runDoctor(home)
    expect(result.stdout).toContain("Installed config scripts")
    expect(result.stdout).toContain("/path with spaces/my hook.ts")
  })

  test("detects non-executable script referenced in installed hook config", async () => {
    const home = await createTempHome()
    const claudeDir = join(home, ".claude")
    await mkdir(claudeDir, { recursive: true })
    const scriptPath = join(home, "non-exec-hook.ts")
    await writeFile(scriptPath, "#!/usr/bin/env bun\n", { mode: 0o644 })
    await writeFile(
      join(claudeDir, "settings.json"),
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: "command", command: `bun ${scriptPath}` }] }],
        },
      })
    )
    const result = await runDoctor(home)
    expect(result.stdout).toContain("Installed config scripts")
    expect(result.stdout).toContain("not executable")
    expect(result.stdout).toContain(scriptPath)
  })

  test("detects missing script referenced in scripts key", async () => {
    const home = await createTempHome()
    const claudeDir = join(home, ".claude")
    await mkdir(claudeDir, { recursive: true })
    await writeFile(
      join(claudeDir, "settings.json"),
      JSON.stringify({
        hooks: {
          Stop: [{ scripts: "bun /from/scripts/key/hook.ts" }],
        },
      })
    )
    const result = await runDoctor(home)
    expect(result.stdout).toContain("Installed config scripts")
    expect(result.stdout).toContain("/from/scripts/key/hook.ts")
  })

  test("detects missing script referenced in run key", async () => {
    const home = await createTempHome()
    const claudeDir = join(home, ".claude")
    await mkdir(claudeDir, { recursive: true })
    await writeFile(
      join(claudeDir, "settings.json"),
      JSON.stringify({
        hooks: {
          Stop: [{ run: "bun /from/run/key/hook.ts" }],
        },
      })
    )
    const result = await runDoctor(home)
    expect(result.stdout).toContain("Installed config scripts")
    expect(result.stdout).toContain("/from/run/key/hook.ts")
  })

  test("detects missing script referenced in args array", async () => {
    const home = await createTempHome()
    const claudeDir = join(home, ".claude")
    await mkdir(claudeDir, { recursive: true })
    await writeFile(
      join(claudeDir, "settings.json"),
      JSON.stringify({
        hooks: {
          Stop: [{ args: ["bun", "/from/args/array/hook.ts"] }],
        },
      })
    )
    const result = await runDoctor(home)
    expect(result.stdout).toContain("Installed config scripts")
    expect(result.stdout).toContain("/from/args/array/hook.ts")
  })

  test("reports GitHub CLI auth status", async () => {
    const home = await createTempHome()
    const result = await runDoctor(home)
    expect(result.stdout).toContain("GitHub CLI auth")
  })

  test("reports TTS backend status", async () => {
    const home = await createTempHome()
    const result = await runDoctor(home)
    expect(result.stdout).toContain("TTS backend")
  })

  test("reports swiz settings status", async () => {
    const home = await createTempHome()
    const result = await runDoctor(home)
    expect(result.stdout).toContain("Swiz settings")
  })

  test("detects malformed agent settings as failure", async () => {
    const home = await createTempHome()
    const claudeDir = join(home, ".claude")
    await mkdir(claudeDir, { recursive: true })
    await writeFile(join(claudeDir, "settings.json"), "{ invalid json !!!")
    const result = await runDoctor(home)
    expect(result.stdout).toContain("Claude Code settings")
    expect(result.stdout).toContain("malformed JSON")
  })

  test("shows summary counts", async () => {
    const home = await createTempHome()
    const result = await runDoctor(home)
    expect(result.stdout).toMatch(/\d+ passed/)
  })

  test("exits zero when no hard failures", async () => {
    const home = await createTempHome()
    const result = await runDoctor(home)
    // Missing agent binaries and settings are warnings, not failures
    // In a clean repo, hook scripts should all exist
    if (!result.stdout.includes("failed")) {
      expect(result.exitCode).toBe(0)
    }
  })

  test("exits non-zero when hard failures exist", async () => {
    const home = await createTempHome()
    const claudeDir = join(home, ".claude")
    await mkdir(claudeDir, { recursive: true })
    // Write malformed JSON to trigger a failure
    await writeFile(join(claudeDir, "settings.json"), "not json at all")
    const result = await runDoctor(home)
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("check(s) failed")
  })

  test("reports agent binary checks for all agents", async () => {
    const home = await createTempHome()
    const result = await runDoctor(home)
    expect(result.stdout).toContain("Claude Code binary")
    expect(result.stdout).toContain("Cursor binary")
    expect(result.stdout).toContain("Gemini CLI binary")
    expect(result.stdout).toContain("Codex CLI binary")
  })

  test("reports config sync check for configurable agents", async () => {
    const home = await createTempHome()
    const result = await runDoctor(home)
    // All configurable agents should have a config sync check
    expect(result.stdout).toContain("config sync")
  })

  test("warns when agent config is missing dispatch entries", async () => {
    const home = await createTempHome()
    // Create a Claude Code settings file with hooks but no dispatch entries
    const claudeDir = join(home, ".claude")
    await mkdir(claudeDir, { recursive: true })
    await writeFile(
      join(claudeDir, "settings.json"),
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: "command", command: "echo hello" }] }],
        },
      })
    )
    const result = await runDoctor(home)
    expect(result.stdout).toContain("Claude Code config sync")
    expect(result.stdout).toContain("missing dispatch")
  })

  test("passes config sync when all dispatch entries present", async () => {
    const home = await createTempHome()
    const claudeDir = join(home, ".claude")
    await mkdir(claudeDir, { recursive: true })
    // Create settings with all expected dispatch entries (derived dynamically from manifest + agents)
    await writeFile(
      join(claudeDir, "settings.json"),
      JSON.stringify({ hooks: buildExpectedHooks() })
    )
    const result = await runDoctor(home)
    expect(result.stdout).toContain("Claude Code config sync")
    expect(result.stdout).toContain("dispatch entries in sync")
  })

  test("warns about stale configs with fix hint", async () => {
    const home = await createTempHome()
    // Empty settings file = no dispatch entries
    const claudeDir = join(home, ".claude")
    await mkdir(claudeDir, { recursive: true })
    await writeFile(join(claudeDir, "settings.json"), JSON.stringify({ hooks: {} }))
    const result = await runDoctor(home)
    expect(result.stdout).toContain("missing dispatch")
    expect(result.stdout).toContain("swiz install")
  })

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
  })

  test("doctor --fix moves lower-precedence duplicate skills aside safely", async () => {
    const home = await createTempHome()
    const skillName = `doctor-fix-dup-${Date.now()}`
    await createSkill(home, ".gemini/skills", skillName)
    await createSkill(home, ".codex/skills", skillName)

    const fixRun = await runDoctor(home, ["--fix"])
    expect(fixRun.stdout).toContain("Auto-fixing skill conflicts")
    expect(await Bun.file(join(home, ".gemini", "skills", skillName, "SKILL.md")).exists()).toBe(
      true
    )
    expect(await Bun.file(join(home, ".codex", "skills", skillName, "SKILL.md")).exists()).toBe(
      false
    )

    const codexSkillsDir = join(home, ".codex", "skills")
    const movedDirs = (await readdir(codexSkillsDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => name.startsWith(`${skillName}.disabled-by-swiz-`))
    expect(movedDirs.length).toBe(1)

    const afterFix = await runDoctor(home)
    expect(afterFix.stdout).not.toContain(`Skill conflict: ${skillName}`)
  })

  test("reports no orphaned hook scripts in a healthy install", async () => {
    const home = await createTempHome()
    const result = await runDoctor(home)
    expect(result.stdout).toContain("Orphaned hook scripts")
    expect(result.stdout).toContain("no orphaned scripts found")
  })

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
  })

  test("detects skill directory missing SKILL.md as invalid", async () => {
    const home = await createTempHome()
    const skillDir = join(home, ".claude", "skills", "broken-skill")
    await mkdir(skillDir, { recursive: true })
    // No SKILL.md created inside

    const result = await runDoctor(home)
    expect(result.stdout).toContain("Invalid skill: broken-skill")
    expect(result.stdout).toContain("missing SKILL.md")
  })

  test("detects skill with SKILL.md missing description as invalid", async () => {
    const home = await createTempHome()
    const skillDir = join(home, ".claude", "skills", "no-desc-skill")
    await mkdir(skillDir, { recursive: true })
    await writeFile(
      join(skillDir, "SKILL.md"),
      "---\nname: no-desc-skill\n---\n\nNo description field.\n"
    )

    const result = await runDoctor(home)
    expect(result.stdout).toContain("Invalid skill: no-desc-skill")
    expect(result.stdout).toContain("missing required frontmatter field(s): description")
  })

  test("detects skill with SKILL.md missing name as invalid", async () => {
    const home = await createTempHome()
    const skillDir = join(home, ".claude", "skills", "no-name-skill")
    await mkdir(skillDir, { recursive: true })
    await writeFile(
      join(skillDir, "SKILL.md"),
      "---\ndescription: Has description but no name field\n---\n\nContent.\n"
    )

    const result = await runDoctor(home)
    expect(result.stdout).toContain("Invalid skill: no-name-skill")
    expect(result.stdout).toContain("missing required frontmatter field(s): name")
  })

  test("detects skill with SKILL.md missing both name and description as invalid", async () => {
    const home = await createTempHome()
    const skillDir = join(home, ".claude", "skills", "empty-fm-skill")
    await mkdir(skillDir, { recursive: true })
    await writeFile(
      join(skillDir, "SKILL.md"),
      "---\n---\n\nFrontmatter exists but has no fields.\n"
    )

    const result = await runDoctor(home)
    expect(result.stdout).toContain("Invalid skill: empty-fm-skill")
    expect(result.stdout).toContain("missing required frontmatter field(s): name, description")
  })

  test("detects skill with SKILL.md lacking frontmatter block as invalid", async () => {
    const home = await createTempHome()
    const skillDir = join(home, ".claude", "skills", "no-fm-skill")
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, "SKILL.md"), "# Just a heading\n\nNo frontmatter at all.\n")

    const result = await runDoctor(home)
    expect(result.stdout).toContain("Invalid skill: no-fm-skill")
    expect(result.stdout).toContain("no frontmatter block")
  })

  test("reports no invalid skill entries in a healthy install", async () => {
    const home = await createTempHome()
    const result = await runDoctor(home)
    expect(result.stdout).toContain("Invalid skill entries")
    expect(result.stdout).toContain("no invalid skill entries found")
  })

  test("doctor --fix moves invalid skill entry aside", async () => {
    const home = await createTempHome()
    const skillsDir = join(home, ".claude", "skills")
    const skillName = `invalid-skill-${Date.now()}`
    const skillDir = join(skillsDir, skillName)
    await mkdir(skillDir, { recursive: true })
    // No SKILL.md — this is an invalid entry

    const fixRun = await runDoctor(home, ["--fix"])
    expect(fixRun.stdout).toContain("Auto-fixing invalid skill entries")
    expect(await Bun.file(skillDir).exists()).toBe(false)

    const movedDirs = (await readdir(skillsDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((n) => n.startsWith(`${skillName}.disabled-by-swiz-`))
    expect(movedDirs.length).toBe(1)
  })

  test("detects skill where frontmatter name does not match directory name", async () => {
    const home = await createTempHome()
    const skillDir = join(home, ".claude", "skills", "my-skill")
    await mkdir(skillDir, { recursive: true })
    await writeFile(
      join(skillDir, "SKILL.md"),
      "---\nname: different-name\ndescription: test skill\n---\n"
    )

    const result = await runDoctor(home)
    expect(result.stdout).toContain("Invalid skill: my-skill")
    expect(result.stdout).toContain(
      'frontmatter name "different-name" does not match directory name "my-skill"'
    )
  })

  test("does not flag skill with quoted frontmatter name matching directory name", async () => {
    const home = await createTempHome()
    const skillDir = join(home, ".claude", "skills", "quoted-skill")
    await mkdir(skillDir, { recursive: true })
    // Quoted name that matches dir name after stripping quotes
    await writeFile(
      join(skillDir, "SKILL.md"),
      '---\nname: "quoted-skill"\ndescription: test skill\n---\n'
    )

    const result = await runDoctor(home)
    expect(result.stdout).not.toContain("Invalid skill: quoted-skill")
  })

  test("ignores dotdirectories inside skill paths", async () => {
    const home = await createTempHome()
    const skillsDir = join(home, ".claude", "skills")
    // Simulate a .unison temp directory — no SKILL.md inside
    const dotDir = join(skillsDir, ".unison.solid-analysis.abc123.unison.tmp")
    await mkdir(dotDir, { recursive: true })

    const result = await runDoctor(home)
    // The dotdir must not appear as an invalid skill entry
    expect(result.stdout).not.toContain("Invalid skill: .unison")
    expect(result.stdout).toContain("no invalid skill entries found")
  })
})
