import { existsSync } from "node:fs"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { getHomeDir } from "../home.ts"
import { skillCommand } from "./skill.ts"

const HOME = getHomeDir()
const JUNIE_COMMANDS_DIR = join(HOME, ".junie", "commands")
const CLAUDE_SKILLS_DIR = join(HOME, ".claude", "skills")

describe("skill to-command", () => {
  afterEach(async () => {
    // Cleanup created files if they exist
    if (existsSync(join(CLAUDE_SKILLS_DIR, "test-skill"))) {
      await rm(join(CLAUDE_SKILLS_DIR, "test-skill"), { recursive: true, force: true })
    }
    if (existsSync(join(JUNIE_COMMANDS_DIR, "test-skill.md"))) {
      await rm(join(JUNIE_COMMANDS_DIR, "test-skill.md"), { force: true })
    }
  })

  it("should export a skill to a junie command", async () => {
    // 1. Create a dummy skill for Claude
    const skillDir = join(CLAUDE_SKILLS_DIR, "test-skill")
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
    await skillCommand.run(["--to-command", "--from", "claude", "test-skill"])

    // 3. Verify the command was created in ~/.junie/commands/test-skill.md
    const commandPath = join(JUNIE_COMMANDS_DIR, "test-skill.md")
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
    // 1. Create a dummy skill for Gemini
    const geminiSkillsDir = join(HOME, ".gemini", "skills")
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

    try {
      // 2. Run the export command
      await skillCommand.run(["--to-command", "--from", "gemini", "gemini-skill"])

      // 3. Verify the command was created and tools remapped to canonical names (Junie has no aliases)
      const commandPath = join(JUNIE_COMMANDS_DIR, "gemini-skill.md")
      expect(existsSync(commandPath)).toBe(true)

      const commandContent = await readFile(commandPath, "utf-8")
      // run_shell_command -> Bash
      // replace -> Edit
      expect(commandContent).toContain("allowed-tools: Bash, Edit")
      expect(commandContent).toContain("To use this skill, call Bash.")
    } finally {
      await rm(skillDir, { recursive: true, force: true })
      if (existsSync(join(JUNIE_COMMANDS_DIR, "gemini-skill.md"))) {
        await rm(join(JUNIE_COMMANDS_DIR, "gemini-skill.md"), { force: true })
      }
    }
  })
})
