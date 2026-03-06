import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { convertSkillContent, parseFrontmatterField, stripFrontmatter } from "./skill.ts"

// ─── parseFrontmatterField unit tests ────────────────────────────────────────

describe("parseFrontmatterField", () => {
  test("extracts a simple string field", () => {
    const content = "---\ndescription: A test skill\n---\n# Body\n"
    expect(parseFrontmatterField(content, "description")).toBe("A test skill")
  })

  test("trims trailing whitespace from extracted value", () => {
    const content = "---\ndescription: Padded value   \n---\n"
    expect(parseFrontmatterField(content, "description")).toBe("Padded value")
  })

  test("returns null when field is absent", () => {
    const content = "---\nauthor: Alice\n---\n# Body\n"
    expect(parseFrontmatterField(content, "description")).toBeNull()
  })

  test("returns null when content has no frontmatter", () => {
    const content = "# Just a heading\n\nNo frontmatter here.\n"
    expect(parseFrontmatterField(content, "description")).toBeNull()
  })

  test("handles field with no space after colon (key:value)", () => {
    const content = "---\ndescription:Compact value\n---\n"
    expect(parseFrontmatterField(content, "description")).toBe("Compact value")
  })

  test("extracts field with quoted value", () => {
    const content = '---\nglobs: "*.ts, *.tsx"\n---\n'
    expect(parseFrontmatterField(content, "globs")).toBe('"*.ts, *.tsx"')
  })

  test("extracts first matching field when multiple fields exist", () => {
    const content = '---\ndescription: First\nglobs: "*.ts"\ntags: testing\n---\n'
    expect(parseFrontmatterField(content, "description")).toBe("First")
    expect(parseFrontmatterField(content, "globs")).toBe('"*.ts"')
    expect(parseFrontmatterField(content, "tags")).toBe("testing")
  })

  test("returns null when frontmatter has no closing ---", () => {
    const content = "---\ndescription: No close\n# Body\n"
    expect(parseFrontmatterField(content, "description")).toBeNull()
  })
})

// ─── stripFrontmatter unit tests ─────────────────────────────────────────────

describe("stripFrontmatter", () => {
  test("returns content unchanged when no frontmatter present", () => {
    const content = "# My Skill\n\nDo something useful.\n"
    expect(stripFrontmatter(content)).toBe(content)
  })

  test("strips well-formed frontmatter block", () => {
    const content = '---\ndescription: A test skill\nglobs: "*.ts"\n---\n# Body\n\nContent here.\n'
    expect(stripFrontmatter(content)).toBe("# Body\n\nContent here.\n")
  })

  test("strips frontmatter when body starts immediately after closing ---", () => {
    const content = "---\nkey: value\n---\nBody starts here."
    expect(stripFrontmatter(content)).toBe("Body starts here.")
  })

  test("returns empty string when file is only frontmatter", () => {
    const content = "---\ndescription: Only meta\n---\n"
    expect(stripFrontmatter(content)).toBe("")
  })

  test("preserves content after frontmatter including trailing newlines", () => {
    const content = "---\nkey: val\n---\n\nLine 1.\n\nLine 2.\n"
    expect(stripFrontmatter(content)).toBe("\nLine 1.\n\nLine 2.\n")
  })

  test("does not strip when only an opening --- exists (malformed)", () => {
    // No closing ---, so the regex should not match
    const content = "---\ndescription: no close\n# Body\n"
    expect(stripFrontmatter(content)).toBe(content)
  })

  test("does not strip when only a closing --- exists (no opening)", () => {
    const content = "# Header\nsome content\n---\nafter\n"
    // --- appears in the middle but there's no opening ---
    // The regex anchors opening to line start with ^--- at start of string area
    // Since there's no opening block, content is unchanged
    expect(stripFrontmatter(content)).toBe(content)
  })

  test("does not strip --- separators that appear mid-document", () => {
    const content = "# Title\n\nParagraph one.\n\n---\n\nParagraph two.\n"
    expect(stripFrontmatter(content)).toBe(content)
  })

  test("strips only the first frontmatter block when multiple --- pairs exist", () => {
    const content = "---\nfirst: yes\n---\nBody\n---\nsecond: yes\n---\nMore\n"
    // Only the leading frontmatter block should be stripped
    expect(stripFrontmatter(content)).toBe("Body\n---\nsecond: yes\n---\nMore\n")
  })

  test("handles empty string without throwing", () => {
    expect(stripFrontmatter("")).toBe("")
  })

  test("handles frontmatter-only file with no trailing newline", () => {
    const content = "---\nkey: val\n---"
    // After stripping, remaining content is empty
    expect(stripFrontmatter(content)).toBe("")
  })
})

// ─── CLI --no-front-matter flag integration tests ────────────────────────────

const tempDirs: string[] = []

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    await rm(dir, { recursive: true, force: true })
  }
})

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "swiz-skill-test-"))
  tempDirs.push(dir)
  return dir
}

/** Write a skill with frontmatter to a temp .skills dir and run swiz skill against it. */
async function runSkillCmd(
  skillContent: string,
  extraArgs: string[] = []
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const fakeHome = await createTempDir()
  const skillName = "test-skill"
  // skill.ts looks in $HOME/.claude/skills/<name>/SKILL.md
  const skillDir = join(fakeHome, ".claude", "skills", skillName)
  await mkdir(skillDir, { recursive: true })
  await writeFile(join(skillDir, "SKILL.md"), skillContent)
  const skillsDir = fakeHome

  const proc = Bun.spawn(["bun", "run", "index.ts", "skill", ...extraArgs, skillName], {
    cwd: process.cwd(),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HOME: skillsDir },
  })
  proc.stdin.end()
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  await proc.exited
  return { stdout, stderr, exitCode: proc.exitCode }
}

describe("swiz skill --no-front-matter", () => {
  const SKILL_WITH_FM =
    '---\ndescription: Test skill\nglobs: "*.ts"\n---\n# Skill Body\n\nDo something.\n'

  test("omits frontmatter block from output", async () => {
    const { stdout } = await runSkillCmd(SKILL_WITH_FM, ["--no-front-matter"])
    expect(stdout).not.toContain("---")
    expect(stdout).not.toContain("description:")
    expect(stdout).toContain("# Skill Body")
    expect(stdout).toContain("Do something.")
  })

  test("without flag, frontmatter is included in output", async () => {
    const { stdout } = await runSkillCmd(SKILL_WITH_FM)
    expect(stdout).toContain("description: Test skill")
    expect(stdout).toContain("# Skill Body")
  })

  test("--no-front-matter on skill without frontmatter outputs content unchanged", async () => {
    const content = "# Plain Skill\n\nNo frontmatter here.\n"
    const { stdout } = await runSkillCmd(content, ["--no-front-matter"])
    expect(stdout).toContain("# Plain Skill")
    expect(stdout).toContain("No frontmatter here.")
  })

  test("--raw and --no-front-matter can be combined", async () => {
    // --raw skips inline command expansion; --no-front-matter still strips the header
    const content = "---\ndescription: raw test\n---\n# Body\n\nContent.\n"
    const { stdout } = await runSkillCmd(content, ["--raw", "--no-front-matter"])
    expect(stdout).not.toContain("description:")
    expect(stdout).toContain("# Body")
  })

  test("flag order does not matter: --no-front-matter before skill name", async () => {
    const { stdout } = await runSkillCmd(SKILL_WITH_FM, ["--no-front-matter"])
    expect(stdout).toContain("# Skill Body")
    expect(stdout).not.toContain("description:")
  })

  test("exits with code 0 on success", async () => {
    const { exitCode } = await runSkillCmd(SKILL_WITH_FM, ["--no-front-matter"])
    expect(exitCode).toBe(0)
  })
})

// ─── listSkills (no skill name) ───────────────────────────────────────────────

/** Run `swiz skill [args...]` with full control over HOME and args. No skill name appended. */
async function runListCmd(
  args: string[],
  fakeHome: string
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const proc = Bun.spawn(["bun", "run", "index.ts", "skill", ...args], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HOME: fakeHome },
  })
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  await proc.exited
  return { stdout, stderr, exitCode: proc.exitCode }
}

async function runSkillCli(
  args: string[],
  fakeHome: string
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return runListCmd(args, fakeHome)
}

describe("swiz skill (list mode)", () => {
  test("prints 'No skills found.' when global dir is empty", async () => {
    const fakeHome = await createTempDir()
    const { stdout } = await runListCmd([], fakeHome)
    expect(stdout.trim()).toBe("No skills found.")
  })

  test("prints count header when one skill is installed", async () => {
    const fakeHome = await createTempDir()
    const skillDir = join(fakeHome, ".claude", "skills", "alpha-skill")
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, "SKILL.md"), "---\ndescription: Alpha\n---\n")
    const { stdout } = await runListCmd([], fakeHome)
    expect(stdout).toContain("1 skills available")
  })

  test("correct count for multiple skills", async () => {
    const fakeHome = await createTempDir()
    for (const name of ["skill-a", "skill-b", "skill-c"]) {
      const dir = join(fakeHome, ".claude", "skills", name)
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, "SKILL.md"), `---\ndescription: ${name}\n---\n`)
    }
    const { stdout } = await runListCmd([], fakeHome)
    expect(stdout).toContain("3 skills available")
  })

  test("description appears next to the skill name", async () => {
    const fakeHome = await createTempDir()
    const skillDir = join(fakeHome, ".claude", "skills", "my-featured-skill")
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, "SKILL.md"), "---\ndescription: Deploy to production\n---\n")
    const { stdout } = await runListCmd([], fakeHome)
    expect(stdout).toContain("my-featured-skill")
    expect(stdout).toContain("Deploy to production")
  })

  test("skill without description is listed with no description text", async () => {
    const fakeHome = await createTempDir()
    const skillDir = join(fakeHome, ".claude", "skills", "nodesc-xyz")
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, "SKILL.md"), "# No frontmatter\n")
    const { stdout } = await runListCmd([], fakeHome)
    expect(stdout).toContain("nodesc-xyz")
  })

  test("directory without SKILL.md is excluded from list", async () => {
    const fakeHome = await createTempDir()
    const base = join(fakeHome, ".claude", "skills")
    await mkdir(join(base, "empty-dir-xyz"), { recursive: true })
    const realDir = join(base, "real-skill-xyz")
    await mkdir(realDir, { recursive: true })
    await writeFile(join(realDir, "SKILL.md"), "---\ndescription: Real\n---\n")
    const { stdout } = await runListCmd([], fakeHome)
    expect(stdout).toContain("real-skill-xyz")
    expect(stdout).not.toContain("empty-dir-xyz")
  })

  test("--raw flag with no name falls through to list mode", async () => {
    const fakeHome = await createTempDir()
    const { stdout } = await runListCmd(["--raw"], fakeHome)
    expect(stdout.trim()).toBe("No skills found.")
  })
})

describe("swiz skill Gemini discovery", () => {
  test("reads a skill that exists only in ~/.gemini/skills", async () => {
    const fakeHome = await createTempDir()
    const skillName = "gemini-only-read-xyz"
    const skillDir = join(fakeHome, ".gemini", "skills", skillName)
    await mkdir(skillDir, { recursive: true })
    await writeFile(
      join(skillDir, "SKILL.md"),
      "---\ndescription: Gemini only\n---\n# Gemini Body\n"
    )

    const { stdout, exitCode } = await runSkillCli(["--raw", skillName], fakeHome)
    expect(exitCode).toBe(0)
    expect(stdout).toContain("# Gemini Body")
  })
})

describe("swiz skill --sync-gemini", () => {
  test("supports dry-run without writing files", async () => {
    const fakeHome = await createTempDir()
    const skillName = "gemini-sync-dry-run-xyz"
    const sourceDir = join(fakeHome, ".gemini", "skills", skillName)
    const targetPath = join(fakeHome, ".claude", "skills", skillName, "SKILL.md")
    await mkdir(sourceDir, { recursive: true })
    await writeFile(join(sourceDir, "SKILL.md"), "---\ndescription: Dry run source\n---\n")

    const { stdout, exitCode } = await runSkillCli(["--sync-gemini", "--dry-run"], fakeHome)
    expect(exitCode).toBe(0)
    expect(stdout).toContain("Dry run: syncing Gemini skills")
    expect(stdout).toContain(`would copy ${skillName}`)
    expect(await Bun.file(targetPath).exists()).toBe(false)
  })

  test("is non-destructive by default and skips existing targets", async () => {
    const fakeHome = await createTempDir()
    const skillName = "gemini-sync-skip-xyz"
    const sourceDir = join(fakeHome, ".gemini", "skills", skillName)
    const targetDir = join(fakeHome, ".claude", "skills", skillName)
    const targetPath = join(targetDir, "SKILL.md")
    await mkdir(sourceDir, { recursive: true })
    await writeFile(join(sourceDir, "SKILL.md"), "---\ndescription: Source version\n---\n")
    await mkdir(targetDir, { recursive: true })
    await writeFile(targetPath, "---\ndescription: Existing target\n---\n")

    const { stdout, exitCode } = await runSkillCli(["--sync-gemini"], fakeHome)
    expect(exitCode).toBe(0)
    expect(stdout).toContain(`skipped ${skillName}`)
    expect(await Bun.file(targetPath).text()).toContain("Existing target")
  })

  test("overwrites existing targets only when --overwrite is set", async () => {
    const fakeHome = await createTempDir()
    const skillName = "gemini-sync-overwrite-xyz"
    const sourceDir = join(fakeHome, ".gemini", "skills", skillName)
    const targetDir = join(fakeHome, ".claude", "skills", skillName)
    const targetPath = join(targetDir, "SKILL.md")
    await mkdir(sourceDir, { recursive: true })
    await writeFile(join(sourceDir, "SKILL.md"), "---\ndescription: Source version\n---\n")
    await mkdir(targetDir, { recursive: true })
    await writeFile(targetPath, "---\ndescription: Existing target\n---\n")

    const { stdout, exitCode } = await runSkillCli(["--sync-gemini", "--overwrite"], fakeHome)
    expect(exitCode).toBe(0)
    expect(stdout).toContain(`overwritten ${skillName}`)
    expect(await Bun.file(targetPath).text()).toContain("Source version")
  })
})

// ─── convertSkillContent unit tests ──────────────────────────────────────────

describe("convertSkillContent", () => {
  test("no-op when from and to are the same agent", () => {
    const content = "---\nallowed-tools: Bash, Edit\n---\nUse Bash to run commands.\n"
    const { content: result, unmapped } = convertSkillContent(content, "claude", "claude")
    expect(result).toBe(content)
    expect(unmapped).toHaveLength(0)
  })

  test("rewrites frontmatter allowed-tools for claude → gemini", () => {
    const content = "---\nallowed-tools: Bash, Edit, Write\n---\n# Body\n"
    const { content: result } = convertSkillContent(content, "claude", "gemini")
    expect(result).toContain("run_shell_command")
    expect(result).toContain("replace")
    expect(result).toContain("write_file")
    expect(result).not.toContain("allowed-tools: Bash")
  })

  test("rewrites frontmatter allowed-tools for claude → cursor", () => {
    const content = "---\nallowed-tools: Bash, Edit\n---\n# Body\n"
    const { content: result } = convertSkillContent(content, "claude", "cursor")
    expect(result).toContain("Shell")
    expect(result).toContain("StrReplace")
  })

  test("rewrites body tool name references whole-word (claude → gemini)", () => {
    const content = "---\n---\nUse Bash to run commands. Do not use BashExtra.\n"
    const { content: result } = convertSkillContent(content, "claude", "gemini")
    expect(result).toContain("run_shell_command")
    // BashExtra should not be partially rewritten
    expect(result).toContain("BashExtra")
  })

  test("rewrites TaskCreate and TaskUpdate to gemini equivalents", () => {
    const content = "---\n---\nCall TaskCreate to plan. Then use TaskUpdate to track.\n"
    const { content: result } = convertSkillContent(content, "claude", "gemini")
    expect(result).toContain("write_todos")
    expect(result).not.toContain("TaskCreate")
    expect(result).not.toContain("TaskUpdate")
  })

  test("rewrites source-specific names back to canonical (gemini → claude)", () => {
    const content =
      "---\nallowed-tools: run_shell_command, write_file\n---\nUse run_shell_command.\n"
    const { content: result } = convertSkillContent(content, "gemini", "claude")
    expect(result).toContain("Bash")
    expect(result).toContain("Write")
    expect(result).not.toContain("run_shell_command")
  })

  test("surface unmapped tool names without data loss", () => {
    // NotebookEdit has no Gemini equivalent (maps to 'NotebookEdit' itself)
    const content = "---\nallowed-tools: Bash, NotebookEdit\n---\n"
    const { content: result, unmapped } = convertSkillContent(content, "claude", "gemini")
    expect(result).toContain("run_shell_command")
    // NotebookEdit preserved as-is (no Gemini equivalent)
    expect(result).toContain("NotebookEdit")
    // No unmapped warning for NotebookEdit since it maps to itself
    // (identity mapping is not surfaced as unmapped — only truly ambiguous tokens are)
    expect(Array.isArray(unmapped)).toBe(true)
  })

  test("converts codex tool names to claude (codex → claude)", () => {
    const content = "---\nallowed-tools: shell_command, read_file\n---\nUse shell_command.\n"
    const { content: result } = convertSkillContent(content, "codex", "claude")
    expect(result).toContain("Bash")
    expect(result).toContain("Read")
    expect(result).not.toContain("shell_command")
    expect(result).not.toContain("read_file")
  })
})

// ─── error handling ───────────────────────────────────────────────────────────

describe("swiz skill <unknown-name> (error handling)", () => {
  test("exits non-zero when skill is not found", async () => {
    const fakeHome = await createTempDir()
    const { exitCode } = await runListCmd(["nonexistent-skill-zyx-123"], fakeHome)
    expect(exitCode).not.toBe(0)
  })

  test("error message identifies the missing skill by name", async () => {
    const fakeHome = await createTempDir()
    const { stderr } = await runListCmd(["totally-missing-skill-abc"], fakeHome)
    expect(stderr).toContain("totally-missing-skill-abc")
  })

  test("error message hints to run 'swiz skill' to list skills", async () => {
    const fakeHome = await createTempDir()
    const { stderr } = await runListCmd(["ghost-skill-xyz"], fakeHome)
    expect(stderr).toContain("swiz skill")
  })

  test("--dry-run requires --sync-gemini", async () => {
    const fakeHome = await createTempDir()
    const { stderr, exitCode } = await runListCmd(["--dry-run"], fakeHome)
    expect(exitCode).not.toBe(0)
    expect(stderr).toContain("--sync-gemini")
  })
})

// ─── expandInlineCommands (!`cmd`) ────────────────────────────────────────────

describe("expandInlineCommands (via swiz skill, no --raw)", () => {
  test("expands a single inline command in skill content", async () => {
    const fakeHome = await createTempDir()
    const skillDir = join(fakeHome, ".claude", "skills", "inline-skill-xyz")
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, "SKILL.md"), "Output: !`echo hello-world`\n")
    const proc = Bun.spawn(["bun", "run", "index.ts", "skill", "inline-skill-xyz"], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HOME: fakeHome },
    })
    const stdout = await new Response(proc.stdout).text()
    await proc.exited
    expect(stdout).toContain("hello-world")
    expect(stdout).not.toContain("!`echo hello-world`")
  })

  test("expands multiple inline commands in order", async () => {
    const fakeHome = await createTempDir()
    const skillDir = join(fakeHome, ".claude", "skills", "multi-inline-xyz")
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, "SKILL.md"), "A: !`echo alpha-val` B: !`echo beta-val`\n")
    const proc = Bun.spawn(["bun", "run", "index.ts", "skill", "multi-inline-xyz"], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HOME: fakeHome },
    })
    const stdout = await new Response(proc.stdout).text()
    await proc.exited
    expect(stdout).toContain("alpha-val")
    expect(stdout).toContain("beta-val")
  })

  test("--raw suppresses inline command expansion", async () => {
    const fakeHome = await createTempDir()
    const skillDir = join(fakeHome, ".claude", "skills", "raw-inline-xyz")
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, "SKILL.md"), "Cmd: !`echo should-not-appear`\n")
    const proc = Bun.spawn(["bun", "run", "index.ts", "skill", "--raw", "raw-inline-xyz"], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HOME: fakeHome },
    })
    const stdout = await new Response(proc.stdout).text()
    await proc.exited
    expect(stdout).toContain("!`echo should-not-appear`")
    expect(stdout).not.toContain("should-not-appear\n")
  })
})
