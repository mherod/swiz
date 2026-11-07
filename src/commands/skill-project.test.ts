import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, rename, symlink } from "node:fs/promises"
import { join } from "node:path"
import { runCommandInProcess, useTempDir } from "../utils/test-utils.ts"
import { type SkillCommandOptions, skillCommand } from "./skill.ts"

const temp = useTempDir("skill-project-")

async function fixture() {
  const root = await temp.create()
  const home = join(root, "home")
  const project = join(root, "plugg-platform")
  await mkdir(home)
  await mkdir(join(project, ".git"), { recursive: true })
  return {
    home,
    project,
    run: (args: string[], cwd = project, commandOptions?: SkillCommandOptions) =>
      runCommandInProcess(skillCommand, args, { cwd, env: { HOME: home }, commandOptions }),
  }
}

async function skill(root: string, agent: string, name: string, content: string) {
  const path = join(root, `.${agent}`, "skills", name, "SKILL.md")
  await Bun.write(path, content)
  return path
}

async function recordVersion(root: string) {
  for (const args of [
    ["init", "-q"],
    ["add", "."],
    ["commit", "-qm", "fixture"],
  ]) {
    const proc = Bun.spawn(
      [
        "git",
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          HOME: root,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
          GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
        },
        stdout: "pipe",
        stderr: "pipe",
      }
    )
    const [, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    await proc.exited
    if (proc.exitCode !== 0) throw new Error(stderr)
  }
}

describe("swiz skill --sync-project", () => {
  test("holds a retained section when its proposed reference is itself unsafe", async () => {
    const { home, project, run } = await fixture()
    const anchor = "apps/main-web/hooks/use-accessibility.ts"
    await Bun.write(join(project, anchor), "export {}\n")
    const section = `## Plugg\nUse \`${anchor}\`.\n`
    const original = `# Accessibility\n\n${section}`
    const target = await skill(project, "codex", "apply-a11y", original)
    await recordVersion(project)
    await skill(home, "codex", "apply-a11y", "# Accessibility\n\nRead references/plugg.md.\n")
    await Bun.write(
      join(home, ".codex/skills/apply-a11y/references/plugg.md"),
      `${section}\nRun scripts/missing.ts.\n`
    )
    expect((await run(["--sync-project", "--from", "codex", "--overwrite"])).exitCode).toBe(0)
    expect(await Bun.file(target).text()).toBe(original)
    expect(existsSync(join(project, ".codex/skills/apply-a11y/references/plugg.md"))).toBe(false)
  })

  test("distinguishes skill-local scripts and routing addresses from repository paths", async () => {
    const { home, project, run } = await fixture()
    await skill(home, "codex", "qa", "Use scripts/SKILL.md. Run scripts/check.ts.\n")
    await Bun.write(join(home, ".codex/skills/qa/scripts/check.ts"), "export {}\n")
    expect((await run(["--sync-project", "--from", "codex", "qa"])).exitCode).toBe(0)
    expect(existsSync(join(project, ".codex/skills/qa/scripts/check.ts"))).toBe(true)
  })

  test.each([
    "## Plugg policy\nAccounts qualify when active.\n",
    "## Plugg hooks\nUse apps/main-web/hooks/deleted.ts.\n",
  ])("preserves project guidance requiring human review: %s", async (section) => {
    const { home, project, run } = await fixture()
    const original = `# Policy\n\n${section}`
    const target = await skill(project, "codex", "policy", original)
    await recordVersion(project)
    await skill(home, "codex", "policy", "# Policy\n\nUpdated global guidance.\n")
    const result = await run(["--sync-project", "--from", "codex", "--overwrite"])
    expect(result.stdout).toContain("project guidance needs review")
    expect(await Bun.file(target).text()).toBe(original)
  })

  test("restores the original tree when publishing a replacement group fails", async () => {
    const { home, project, run } = await fixture()
    const target = await skill(project, "codex", "dev", "Original development guidance\n")
    const local = await skill(project, "codex", "project-only", "Keep this\n")
    await recordVersion(project)
    await skill(home, "codex", "dev", alias("serve"))
    await skill(home, "codex", "serve", "Start server\n")
    const result = await run(["--sync-project", "--from", "codex", "dev"], project, {
      syncFileSystem: {
        async moveDirectory(source, destination) {
          if (source.includes(".skills-group-") && source.endsWith("/skills")) {
            throw new Error("injected publication failure")
          }
          await rename(source, destination)
        },
      },
    })
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("injected publication failure")
    expect(await Bun.file(target).text()).toBe("Original development guidance\n")
    expect(await Bun.file(local).text()).toBe("Keep this\n")
    expect(existsSync(join(project, ".codex/skills/serve"))).toBe(false)
  })

  test("preserves an installed project replacement instead of importing its global copy", async () => {
    const { home, project, run } = await fixture()
    await skill(home, "codex", "dev", alias("serve"))
    await skill(home, "codex", "serve", "Global server\n")
    const local = await skill(project, "codex", "serve", "Project server\n")
    expect((await run(["--sync-project", "--from", "codex", "dev"])).exitCode).toBe(0)
    expect(await Bun.file(local).text()).toBe("Project server\n")
  })

  test("preserves project-only references during an unresolved overwrite", async () => {
    const { home, project, run } = await fixture()
    await skill(home, "codex", "example", "Global instructions\n")
    const target = await skill(project, "codex", "example", "Local instructions\n")
    const reference = join(project, ".codex/skills/example/references/local.md")
    await Bun.write(reference, "Only update active accounts.\n")
    expect((await run(["--sync-project", "--from", "codex", "--overwrite"])).exitCode).toBe(0)
    expect(await Bun.file(reference).text()).toBe("Only update active accounts.\n")
    expect(await Bun.file(target).text()).toBe("Local instructions\n")
  })

  test("merges global improvements with verified Plugg accessibility guidance", async () => {
    const { home, project, run } = await fixture()
    const anchor = "apps/main-web/hooks/use-accessibility.ts"
    await Bun.write(join(project, anchor), "export const useAccessibility = () => ({})\n")
    const local = `## Plugg accessibility\nUse \`${anchor}\`. Preserve announcements.\n`
    await skill(
      home,
      "codex",
      "apply-a11y",
      "# Accessibility\n\n## Keyboard\nCheck focus after navigation.\n"
    )
    const target = await skill(project, "codex", "apply-a11y", `# Accessibility\n\n${local}`)
    const args = ["--sync-project", "--from", "codex"]
    expect((await run(args)).exitCode).toBe(0)
    const merged = await Bun.file(target).text()
    expect(merged).toContain("Check focus after navigation.")
    expect(merged).toContain(local)
    expect((await run(args)).exitCode).toBe(0)
    expect(await Bun.file(target).text()).toBe(merged)
  })

  test("holds overlapping project policies even with overwrite", async () => {
    const { home, project, run } = await fixture()
    const anchor = "apps/identity-web/scripts/src/update_domain_status.ts"
    await Bun.write(join(project, anchor), "export {}\n")
    const local = `# Domains\n\n## Review\nUse \`${anchor}\` only with a verified manifest.\n`
    await skill(
      home,
      "codex",
      "verify-institution-domains",
      `# Domains\n\n## Review\nUse \`${anchor}\` for all accounts.\n`
    )
    const target = await skill(project, "codex", "verify-institution-domains", local)
    await recordVersion(project)
    const result = await run(["--sync-project", "--from", "codex", "--overwrite"])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("project guidance needs review")
    expect(await Bun.file(target).text()).toBe(local)
  })

  test("holds incoming missing repository paths before importing", async () => {
    const { home, project, run } = await fixture()
    await skill(home, "codex", "domains", "Run scripts/get_pending_reviews.ts.\n")
    const result = await run(["--sync-project", "--from", "codex", "domains", "--overwrite"])
    expect(result.stdout).toContain("incoming repository paths are absent")
    expect(existsSync(join(project, ".codex/skills/domains"))).toBe(false)
  })

  test("recognizes project guidance relocated into global references", async () => {
    const { home, project, run } = await fixture()
    const anchor = "apps/main-web/hooks/use-accessibility.ts"
    await Bun.write(join(project, anchor), "export {}\n")
    const section = `## Plugg\nUse \`${anchor}\`.\n`
    const target = await skill(project, "codex", "apply-a11y", `# Accessibility\n\n${section}`)
    await recordVersion(project)
    await skill(home, "codex", "apply-a11y", "# Accessibility\n\nRead references/plugg.md.\n")
    await Bun.write(join(home, ".codex/skills/apply-a11y/references/plugg.md"), section)
    expect((await run(["--sync-project", "--from", "codex"])).exitCode).toBe(0)
    expect(await Bun.file(target).text()).not.toContain(section)
    expect(
      await Bun.file(join(project, ".codex/skills/apply-a11y/references/plugg.md")).text()
    ).toBe(section)
  })

  test("imports a renamed replacement chain together and previews without writes", async () => {
    const { home, project, run } = await fixture()
    await skill(home, "codex", "dev", alias("start-dev-server"))
    await skill(home, "codex", "start-dev-server", alias("serve"))
    await skill(home, "codex", "serve", "Start the server.\n")
    const args = ["--sync-project", "--from", "codex", "dev"]
    expect((await run([...args, "--dry-run"])).exitCode).toBe(0)
    expect(existsSync(join(project, ".codex"))).toBe(false)
    expect((await run(args)).exitCode).toBe(0)
    for (const name of ["dev", "start-dev-server", "serve"]) {
      expect(existsSync(join(project, ".codex/skills", name, "SKILL.md"))).toBe(true)
    }
  })

  test("rolls back an alias group when its replacement needs project review", async () => {
    const { home, project, run } = await fixture()
    const target = await skill(project, "codex", "dev", "Local development instructions.\n")
    await recordVersion(project)
    await skill(home, "codex", "dev", alias("start-dev-server"))
    await skill(home, "codex", "start-dev-server", "Run scripts/nonexistent-server.ts.\n")
    const result = await run(["--sync-project", "--from", "codex", "dev"])
    expect(result.exitCode).toBe(1)
    expect(await Bun.file(target).text()).toBe("Local development instructions.\n")
    expect(existsSync(join(project, ".codex/skills/start-dev-server"))).toBe(false)
  })

  test.each([
    "missing",
    "cyclic",
  ])("rejects %s replacement dependencies before writes", async (mode) => {
    const { home, project, run } = await fixture()
    await skill(home, "codex", "dev", alias("serve"))
    if (mode === "cyclic") await skill(home, "codex", "serve", alias("dev"))
    const result = await run(["--sync-project", "--from", "codex", "dev"])
    expect(result.exitCode).toBe(1)
    expect(existsSync(join(project, ".codex"))).toBe(false)
  })

  test("refreshes the Plugg-style selected subset and preserves project-only skills", async () => {
    const { home, project, run } = await fixture()
    const source = await skill(home, "codex", "apply-a11y", "Current guidance\n")
    await skill(home, "codex", "unselected", "Not selected\n")
    const target = await skill(project, "codex", "apply-a11y", "Old guidance\n")
    const local = await skill(project, "codex", "browser-walkthrough", "Local guidance\n")
    const claude = await skill(project, "claude", "mcp-analytics", "Project analytics\n")
    await recordVersion(project)
    const result = await run(["--sync-project", "--from", "codex"])
    expect(result.exitCode).toBe(0)
    expect(await Bun.file(target).text()).toBe("Current guidance\n")
    expect(await Bun.file(source).text()).toBe("Current guidance\n")
    expect(await Bun.file(local).text()).toBe("Local guidance\n")
    expect(await Bun.file(claude).text()).toBe("Project analytics\n")
    expect(existsSync(join(project, ".codex/skills/unselected"))).toBe(false)
    expect(result.stdout).toContain("project-only; no user source")
  })

  test("imports one skill with converted references and binary assets into an explicit project", async () => {
    const { home, project, run } = await fixture()
    await skill(home, "claude", "example", "Use Bash and Edit.\n")
    await skill(home, "claude", "unselected", "Other\n")
    const sourceDir = join(home, ".claude/skills/example")
    await Bun.write(join(sourceDir, "references/guide.md"), "Use Bash.\n")
    await Bun.write(join(sourceDir, "assets/example.bin"), new Uint8Array([0, 255, 42]))
    const result = await run(
      ["--sync-project", "--from", "claude", "--to", "codex", "--project", project, "example"],
      home
    )
    expect(result.exitCode).toBe(0)
    const targetDir = join(project, ".codex/skills/example")
    expect(await Bun.file(join(targetDir, "SKILL.md")).text()).toContain("shell_command")
    expect(await Bun.file(join(targetDir, "references/guide.md")).text()).toContain("shell_command")
    expect(await Bun.file(join(targetDir, "assets/example.bin")).bytes()).toEqual(
      new Uint8Array([0, 255, 42])
    )
    expect(await Bun.file(join(sourceDir, "SKILL.md")).text()).toBe("Use Bash and Edit.\n")
    expect(existsSync(join(project, ".codex/skills/unselected"))).toBe(false)
  })

  test("dry-run imports nothing and --all imports all user skills", async () => {
    const { home, project, run } = await fixture()
    await skill(home, "codex", "first", "First\n")
    await skill(home, "codex", "second", "Second\n")
    const args = ["--sync-project", "--from", "codex", "--all"]
    const preview = await run([...args, "--dry-run"])
    expect(preview.exitCode).toBe(0)
    expect(preview.stdout).toContain("would copy first")
    expect(existsSync(join(project, ".codex"))).toBe(false)
    expect((await run(args)).exitCode).toBe(0)
    expect(await Bun.file(join(project, ".codex/skills/second/SKILL.md")).text()).toBe("Second\n")
  })

  test("shared user sources exclude project overrides and include the legacy fallback", async () => {
    const { home, project, run } = await fixture()
    await skill(home, "agents", "shared", "User shared\n")
    await Bun.write(join(home, ".agents/legacy/SKILL.md"), "Legacy\n")
    await skill(project, "agents", "shared", "Project override\n")
    const result = await run(["--sync-project", "--from", "agents", "--to", "codex", "--all"])
    expect(result.exitCode).toBe(0)
    expect(await Bun.file(join(project, ".codex/skills/shared/SKILL.md")).text()).toBe(
      "User shared\n"
    )
    expect(await Bun.file(join(project, ".codex/skills/legacy/SKILL.md")).text()).toBe("Legacy\n")
  })

  test("resolves the worktree root from a nested directory", async () => {
    const { home, project, run } = await fixture()
    await skill(home, "codex", "example", "Example\n")
    const nested = join(project, "src/components")
    await mkdir(nested, { recursive: true })
    expect((await run(["--sync-project", "--from", "codex", "example"], nested)).exitCode).toBe(0)
    expect(existsSync(join(project, ".codex/skills/example/SKILL.md"))).toBe(true)
    expect(existsSync(join(nested, ".codex"))).toBe(false)
  })

  test("keeps newer project edits even with --overwrite", async () => {
    const { home, project, run } = await fixture()
    const source = await skill(home, "codex", "example", "Old user guidance\n")
    const target = await skill(project, "codex", "example", "New local guidance\n")
    await recordVersion(home)
    expect((await run(["--sync-project", "--from", "codex", "--overwrite"])).exitCode).toBe(0)
    expect(await Bun.file(target).text()).toBe("New local guidance\n")
    expect(await Bun.file(source).text()).toBe("Old user guidance\n")
  })

  test("does not write through a project skills symlink to user storage", async () => {
    const { home, project, run } = await fixture()
    await skill(home, "codex", "example", "User content\n")
    await mkdir(join(project, ".codex"))
    await symlink(join(home, ".codex/skills"), join(project, ".codex/skills"))
    const result = await run(["--sync-project", "--from", "codex", "--all"])
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("does not support symlinks")
    expect(await Bun.file(join(home, ".codex/skills/example/SKILL.md")).text()).toBe(
      "User content\n"
    )
  })

  test("an empty project selection does not import the user collection", async () => {
    const { home, project, run } = await fixture()
    await skill(home, "codex", "example", "User content\n")
    const result = await run(["--sync-project", "--from", "codex"])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("Pass a skill name or --all")
    expect(existsSync(join(project, ".codex"))).toBe(false)
  })

  test("rejects the user home as a project and requires a project outside Git", async () => {
    const { home, run } = await fixture()
    const args = ["--sync-project", "--from", "codex", "--all"]
    expect((await run(args, home)).stderr).toContain("pass --project")
    expect((await run([...args, "--project", home])).stderr).toContain("must differ")
  })

  test("rejects a linked Markdown asset before conversion can modify its source", async () => {
    const { home, project, run } = await fixture()
    await skill(home, "claude", "example", "Use Bash.\n")
    const external = join(home, "guide.md")
    await Bun.write(external, "Use Bash.\n")
    await symlink(external, join(home, ".claude/skills/example/guide.md"))
    const result = await run(["--sync-project", "--from", "claude", "--to", "codex", "example"])
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("symlinked skill trees")
    expect(await Bun.file(external).text()).toBe("Use Bash.\n")
    expect(existsSync(join(project, ".codex"))).toBe(false)
  })

  test.each(
    [
      ["--sync-project"],
      ["--sync-project", "--from", "codex", "--project"],
      ["--sync-project", "--from", "codex", "--to", "--all"],
      ["--sync-project", "--from", "codex", "missing"],
      ["--sync-project", "--from", "codex", "first", "second"],
      ["--sync-project", "--from", "codex", "first", "--all"],
      ["--sync-project", "--from", "codex", "--sync"],
      ["--sync-project", "--from", "codex", "--install"],
      ["--sync", "--from", "codex", "--all"],
    ].map((args) => ({ args }))
  )("rejects invalid arguments %j", async ({ args }) => {
    const { project, run } = await fixture()
    expect((await run(args)).exitCode).toBe(1)
    expect(existsSync(join(project, ".codex"))).toBe(false)
  })
})

function alias(replacement: string) {
  return `---\nmetadata:\n  deprecated: true\n  replacement: ${replacement}\n---\nUse ${replacement}.\n`
}
