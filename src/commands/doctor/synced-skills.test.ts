import { describe, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { runCommandInProcess, useTempDir } from "../../utils/test-utils.ts"
import { doctorCommand } from "../doctor.ts"
import { invalidSkillEntriesCheck } from "./checks/invalid-skill-entries.ts"

const temp = useTempDir("swiz-synced-skills-")

async function diagnose(home: string, args: string[] = []) {
  return runCommandInProcess(doctorCommand, args, {
    cwd: home,
    env: { HOME: home, AI_TEST_NO_BACKEND: "1" },
    commandOptions: {
      allChecks: [invalidSkillEntriesCheck],
      autoCleanup: async () => {},
      fixStaleConfigs: async () => {},
      fixCleanupLaunchAgent: async () => {},
      notifyDaemon: async () => {},
    },
  })
}

describe("synced skill container diagnostics", () => {
  test("does not diagnose or generate a skill at the Claude synced container", async () => {
    const home = await temp.create()
    const container = join(home, ".claude/skills/synced")
    const nested = join(container, "bucket/example/SKILL.md")
    await Bun.write(nested, "---\nname: example\ndescription: Nested skill\n---\n")
    for (const args of [[], ["--fix"]]) {
      const result = await diagnose(home, args)
      expect(result.exitCode).toBe(0)
      expect(result.stdout).not.toContain("Invalid skill: synced")
      expect(await Bun.file(join(container, "SKILL.md")).exists()).toBe(false)
      expect(await Bun.file(nested).text()).toContain("Nested skill")
    }
  })

  test("still validates ordinary missing skills and explicit synced skill files", async () => {
    const home = await temp.create()
    await mkdir(join(home, ".claude/skills/broken"), { recursive: true })
    await mkdir(join(home, ".skills/synced"), { recursive: true })
    await Bun.write(join(home, ".claude/skills/synced/SKILL.md"), "")
    const result = await diagnose(home)
    expect(result.stdout).toContain("Invalid skill: broken")
    expect(result.stdout).toContain(".skills/synced: missing SKILL.md")
    expect(result.stdout).toContain(".claude/skills/synced: empty SKILL.md")
  })
})
