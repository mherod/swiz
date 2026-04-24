import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { useTempDir } from "../utils/test-utils.ts"

const { create: createTempDir } = useTempDir("swiz-skill-command-test-")

describe("skill to-command", () => {
  it("should export a skill to an agent command", async () => {
    const home = await createTempDir()
    const indexPath = join(process.cwd(), "index.ts")
    const claudeSkillsDir = join(home, ".claude", "skills")

    // 1. Create a dummy skill for Claude
    const skillDir = join(claudeSkillsDir, "test-skill")
    await mkdir(skillDir, { recursive: true })
    const skillContent = `---
description: A test skill
allowed-tools: Bash, Edit
---

## Steps
1. Run a command
2. Edit a file
`
    await writeFile(join(skillDir, "SKILL.md"), skillContent)

    // 2. Run the export command
    // Usage: swiz skill --to-command --from claude [skill-name]
    const proc = Bun.spawn(
      ["bun", "run", indexPath, "skill", "--to-command", "--from", "claude", "test-skill"],
      {
        cwd: home,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, HOME: home },
      }
    )
    const stderr = await new Response(proc.stderr).text()
    await proc.exited
    expect(proc.exitCode).toBe(0)
    expect(stderr).toBe("")

    // 3. Verify the command was created in ~/.claude/commands/test-skill.md
    const commandPath = join(home, ".claude", "commands", "test-skill.md")
    expect(existsSync(commandPath)).toBe(true)

    const commandContent = await readFile(commandPath, "utf-8")
    expect(commandContent).toContain("name: test-skill")
    expect(commandContent).toContain("description: A test skill")
    expect(commandContent).toContain("## Steps")
    expect(commandContent).toContain("1. Run a command")
    // Note: Since Junie has empty tool aliases, tool names should remain the same in this case,
    // or if they were canonicalized, Bash/Edit are already canonical for Claude.
  })

  it("should remap tool names when exporting (e.g. from Gemini)", async () => {
    const home = await createTempDir()
    const indexPath = join(process.cwd(), "index.ts")

    // 1. Create a dummy skill for Gemini
    const geminiSkillsDir = join(home, ".gemini", "skills")
    const skillDir = join(geminiSkillsDir, "gemini-skill")
    await mkdir(skillDir, { recursive: true })

    // Gemini uses run_shell_command instead of Bash
    const skillContent = `---
description: A Gemini test skill
allowed-tools: run_shell_command, replace
---

To use this skill, call run_shell_command.
`
    await writeFile(join(skillDir, "SKILL.md"), skillContent)

    // 2. Run the export command
    const proc = Bun.spawn(
      [
        "bun",
        "run",
        indexPath,
        "skill",
        "--to-command",
        "--from",
        "gemini",
        "--to",
        "claude",
        "gemini-skill",
      ],
      {
        cwd: home,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, HOME: home },
      }
    )
    const stderr = await new Response(proc.stderr).text()
    await proc.exited
    expect(proc.exitCode).toBe(0)
    expect(stderr).toBe("")

    // 3. Verify the command was created and tools remapped to canonical names.
    const commandPath = join(home, ".claude", "commands", "gemini-skill.md")
    expect(existsSync(commandPath)).toBe(true)

    const commandContent = await readFile(commandPath, "utf-8")
    // run_shell_command -> Bash
    // replace -> Edit
    expect(commandContent).toContain("allowed-tools: Bash, Edit")
    expect(commandContent).toContain("To use this skill, call Bash.")
  })
})
