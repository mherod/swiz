import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, symlink } from "node:fs/promises"
import { join } from "node:path"
import { runCommandInProcess, useTempDir } from "../utils/test-utils.ts"
import { skillCommand } from "./skill.ts"

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
    run: (args: string[], cwd = project) =>
      runCommandInProcess(skillCommand, args, { cwd, env: { HOME: home } }),
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
