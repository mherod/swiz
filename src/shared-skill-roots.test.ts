import { describe, expect, test } from "bun:test"
import { mkdir, readdir, symlink } from "node:fs/promises"
import { join } from "node:path"
import { fixSkillConflicts } from "./commands/doctor/fix.ts"
import { skillCommand } from "./commands/skill.ts"
import {
  findSkillConflicts,
  getAgentsSkillDir,
  getAgentsSkillDirs,
  getLegacyAgentsSkillDir,
  getProjectAgentsSkillDirs,
  isSkillCandidateDir,
} from "./skill-utils.ts"
import { runCommandInProcess, useTempDir } from "./utils/test-utils.ts"

const temp = useTempDir("swiz-shared-skill-roots-")

async function writeSkill(root: string, name: string, marker: string): Promise<string> {
  const skillDir = join(root, name)
  const skillPath = join(skillDir, "SKILL.md")
  await mkdir(skillDir, { recursive: true })
  await Bun.write(skillPath, `---\nname: ${name}\ndescription: ${marker}\n---\n\n# ${marker}\n`)
  return skillPath
}

describe("shared Agents skill roots", () => {
  test("orders repository ancestors before the user standard and legacy roots", async () => {
    const fixture = await temp.create()
    const home = join(fixture, "home")
    const repo = join(fixture, "repo")
    const nested = join(repo, "packages", "app")
    await mkdir(join(repo, ".git"), { recursive: true })
    await mkdir(nested, { recursive: true })

    expect(getProjectAgentsSkillDirs(nested)).toEqual([
      join(nested, ".agents", "skills"),
      join(repo, "packages", ".agents", "skills"),
      join(repo, ".agents", "skills"),
    ])
    expect(getAgentsSkillDirs(nested, home)).toEqual([
      join(nested, ".agents", "skills"),
      join(repo, "packages", ".agents", "skills"),
      join(repo, ".agents", "skills"),
      getAgentsSkillDir(home),
      getLegacyAgentsSkillDir(home),
    ])
  })

  test("sync discovers project, user, symlinked, and legacy layouts with first-root precedence", async () => {
    const fixture = await temp.create()
    const home = join(fixture, "home")
    const repo = join(fixture, "repo")
    const nested = join(repo, "packages", "app")
    const projectRoot = join(nested, ".agents", "skills")
    const userRoot = getAgentsSkillDir(home)
    const legacyRoot = getLegacyAgentsSkillDir(home)
    const symlinkTarget = join(fixture, "linked-source")
    await mkdir(join(repo, ".git"), { recursive: true })
    await mkdir(nested, { recursive: true })

    await writeSkill(projectRoot, "dupe", "project winner")
    await writeSkill(userRoot, "dupe", "user loser")
    await writeSkill(userRoot, "user-only", "user standard")
    await writeSkill(legacyRoot, "legacy-only", "legacy fallback")
    await writeSkill(symlinkTarget, "linked", "symlinked skill")
    await mkdir(userRoot, { recursive: true })
    await symlink(join(symlinkTarget, "linked"), join(userRoot, "linked"), "dir")

    const result = await runCommandInProcess(
      skillCommand,
      ["--sync", "--from", "agents", "--to", "claude"],
      { cwd: nested, env: { HOME: home } }
    )

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("4 copied")
    expect(await Bun.file(join(home, ".claude", "skills", "dupe", "SKILL.md")).text()).toContain(
      "project winner"
    )
    expect(await Bun.file(join(home, ".claude", "skills", "user-only", "SKILL.md")).exists()).toBe(
      true
    )
    expect(
      await Bun.file(join(home, ".claude", "skills", "legacy-only", "SKILL.md")).exists()
    ).toBe(true)
    expect(await Bun.file(join(home, ".claude", "skills", "linked", "SKILL.md")).exists()).toBe(
      true
    )
  })

  test("recognizes symlinked skills and excludes the standard container from legacy scanning", async () => {
    const fixture = await temp.create()
    const home = join(fixture, "home")
    const legacyRoot = getLegacyAgentsSkillDir(home)
    const target = join(fixture, "target")
    await writeSkill(target, "linked", "linked")
    await mkdir(legacyRoot, { recursive: true })
    await symlink(join(target, "linked"), join(legacyRoot, "linked"), "dir")
    await mkdir(getAgentsSkillDir(home), { recursive: true })

    const entries = await readdir(legacyRoot, { withFileTypes: true })
    const linked = entries.find((entry) => entry.name === "linked")!
    const skills = entries.find((entry) => entry.name === "skills")!

    expect(isSkillCandidateDir(linked, legacyRoot)).toBe(true)
    expect(isSkillCandidateDir(skills, legacyRoot)).toBe(false)
  })
})

describe("shared-root skill conflicts", () => {
  test("reports one ordered conflict across project, shared, and provider roots", async () => {
    const fixture = await temp.create()
    const projectRoot = join(fixture, "repo", ".agents", "skills")
    const sharedRoot = join(fixture, "home", ".agents", "skills")
    const providerRoot = join(fixture, "home", ".claude", "skills")
    const projectPath = await writeSkill(projectRoot, "overlap", "project")
    const sharedPath = await writeSkill(sharedRoot, "overlap", "shared")
    const providerPath = await writeSkill(providerRoot, "overlap", "provider")

    const conflicts = await findSkillConflicts([projectRoot, sharedRoot, providerRoot])

    expect(conflicts).toEqual([
      {
        name: "overlap",
        active: { dir: projectRoot, path: projectPath, shared: true },
        overridden: [
          { dir: sharedRoot, path: sharedPath, shared: true },
          { dir: providerRoot, path: providerPath, shared: false },
        ],
      },
    ])
  })

  test("doctor fix routes shared-root conflicts to manual resolution without removing data", async () => {
    const fixture = await temp.create()
    const sharedRoot = join(fixture, ".agents", "skills")
    const providerRoot = join(fixture, ".claude", "skills")
    const sharedPath = await writeSkill(sharedRoot, "safe", "shared")
    const providerPath = await writeSkill(providerRoot, "safe", "provider")
    const conflicts = await findSkillConflicts([sharedRoot, providerRoot])

    const messages = await fixSkillConflicts(conflicts, true)

    expect(messages).toEqual([expect.stringContaining("shared-root conflict")])
    expect(messages[0]).toContain("no files removed")
    expect(await Bun.file(sharedPath).exists()).toBe(true)
    expect(await Bun.file(providerPath).exists()).toBe(true)
  })
})
