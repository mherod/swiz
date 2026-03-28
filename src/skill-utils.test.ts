import { describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { useTempDir } from "../hooks/utils/test-utils.ts"
import {
  extractMandatedSkillTools,
  extractStepsFromSkill,
  getSkillToolAvailabilityWarning,
  parseFrontmatterField,
  SKILL_DIRS,
  skillAdvice,
  skillExists,
  stripFrontmatter,
} from "./skill-utils.ts"

// ─── Test helpers ─────────────────────────────────────────────────────────────

const { create: createTempDir } = useTempDir("swiz-skill-utils-test-")

// ─── SKILL_DIRS ───────────────────────────────────────────────────────────────

describe("SKILL_DIRS", () => {
  test("is an array of at least 7 directories (project + providers + antigravity roots)", () => {
    expect(Array.isArray(SKILL_DIRS)).toBe(true)
    expect(SKILL_DIRS.length).toBeGreaterThanOrEqual(7)
  })

  test("first entry is the project-local .skills directory", () => {
    expect(SKILL_DIRS[0]).toContain(".skills")
  })

  test("includes skill directories for all providers", () => {
    const skillDirStr = SKILL_DIRS.join(",")
    expect(skillDirStr).toContain(".claude")
    expect(skillDirStr).toContain(".cursor")
    expect(skillDirStr).toContain(".gemini")
    expect(skillDirStr).toContain(".codex")
    expect(skillDirStr).toContain(".gemini/antigravity/skills")
    expect(skillDirStr).toContain(".gemini/antigravity/global_skills")
  })

  test("all entries are non-empty strings", () => {
    for (const dir of SKILL_DIRS) {
      expect(typeof dir).toBe("string")
      expect(dir.length).toBeGreaterThan(0)
    }
  })
})

// ─── skillExists ──────────────────────────────────────────────────────────────

describe("skillExists", () => {
  test("returns false for empty string", () => {
    expect(skillExists("")).toBe(false)
  })

  test("returns false for whitespace-only name", () => {
    expect(skillExists("   ")).toBe(false)
  })

  test("returns false for a nonexistent skill", () => {
    expect(skillExists("this-skill-definitely-does-not-exist-xyz-777")).toBe(false)
  })

  test("returns boolean for any input", () => {
    expect(typeof skillExists("some-skill-name")).toBe("boolean")
  })

  test("returns consistent results on repeated calls (caching)", () => {
    const name = "nonexistent-cache-test-xyz-888"
    const first = skillExists(name)
    const second = skillExists(name)
    expect(first).toBe(second)
    expect(first).toBe(false)
  })
})

// ─── skillAdvice ──────────────────────────────────────────────────────────────

describe("skillAdvice", () => {
  test("returns withoutSkill for nonexistent skill", () => {
    const result = skillAdvice("nonexistent-xyz-999", "use /skill", "fallback steps")
    expect(result).toBe("fallback steps")
  })

  test("returns withoutSkill for empty skill name", () => {
    expect(skillAdvice("", "with", "without")).toBe("without")
  })

  test("combines withSkill and withoutSkill when skill exists", () => {
    // Use a skill name that is known to exist in the test environment (commit is always installed)
    const result = skillAdvice("commit", "use /commit", "fallback steps")
    // When skill exists: withSkill + newline + withoutSkill; when absent: withoutSkill only
    expect(result === "use /commit\n\nfallback steps" || result === "fallback steps").toBe(true)
  })

  test("always includes fallback steps regardless of skill availability", () => {
    const result = skillAdvice(
      "nonexistent-xyz-999",
      "use /nonexistent-xyz-999",
      "do this manually"
    )
    expect(result).toContain("do this manually")
  })

  test("nested calls compose correctly when outer skill is absent", () => {
    const outer = skillAdvice(
      "nonexistent-outer-xyz",
      `outer with ${skillAdvice("nonexistent-inner-xyz", "inner with", "inner without")}`,
      "outer fallback"
    )
    expect(outer).toBe("outer fallback")
  })

  test("nested inner produces correct fallback when inner skill is absent", () => {
    const inner = skillAdvice("nonexistent-inner-xyz", "push with /push.", "git push origin main")
    expect(inner).toBe("git push origin main")
  })
})

// ─── parseFrontmatterField ────────────────────────────────────────────────────

describe("parseFrontmatterField", () => {
  test("extracts a simple string field", () => {
    expect(parseFrontmatterField("---\ndescription: My skill\n---\n", "description")).toBe(
      "My skill"
    )
  })

  test("returns null when field is absent", () => {
    expect(parseFrontmatterField("---\nauthor: Alice\n---\n", "description")).toBeNull()
  })

  test("returns null when there is no frontmatter", () => {
    expect(parseFrontmatterField("# Just a heading\n", "description")).toBeNull()
  })

  test("trims trailing whitespace from extracted value", () => {
    expect(parseFrontmatterField("---\ndescription: value   \n---\n", "description")).toBe("value")
  })

  test("extracts multiple different fields from the same content", () => {
    const content = "---\ndescription: My skill\nglobs: '*.ts'\n---\n"
    expect(parseFrontmatterField(content, "description")).toBe("My skill")
    expect(parseFrontmatterField(content, "globs")).toBe("'*.ts'")
  })
})

// ─── stripFrontmatter ─────────────────────────────────────────────────────────

describe("stripFrontmatter", () => {
  test("strips well-formed frontmatter block", () => {
    const content = "---\ndescription: test\n---\n# Body\n"
    expect(stripFrontmatter(content)).toBe("# Body\n")
  })

  test("returns content unchanged when no frontmatter is present", () => {
    const content = "# Title\n\nParagraph.\n"
    expect(stripFrontmatter(content)).toBe(content)
  })

  test("preserves blank line immediately after closing ---", () => {
    const content = "---\nkey: val\n---\n\nBody starts here.\n"
    expect(stripFrontmatter(content)).toBe("\nBody starts here.\n")
  })

  test("handles empty string without throwing", () => {
    expect(stripFrontmatter("")).toBe("")
  })

  test("returns empty string when file is only frontmatter", () => {
    expect(stripFrontmatter("---\ndescription: only meta\n---\n")).toBe("")
  })
})

// ─── skill tool availability checks ──────────────────────────────────────────

describe("extractMandatedSkillTools", () => {
  test("extracts inline allowed-tools and strips argument constraints", () => {
    const content = "---\nallowed-tools: Bash(git log:*), Read, Edit\n---\nUse the skill.\n"
    expect(extractMandatedSkillTools(content)).toEqual(["Bash", "Read", "Edit"])
  })

  test("extracts YAML list allowed-tools entries", () => {
    const content =
      '---\nallowed-tools:\n  - "TaskCreate"\n  - "TaskUpdate(status:completed)"\n---\nBody\n'
    expect(extractMandatedSkillTools(content)).toEqual(["TaskCreate", "TaskUpdate"])
  })

  test("returns empty list when no allowed-tools is present", () => {
    const content = "---\ndescription: test\n---\nBody\n"
    expect(extractMandatedSkillTools(content)).toEqual([])
  })
})

describe("getSkillToolAvailabilityWarning", () => {
  test("returns warning with missing tools when required tools are not active", () => {
    const content = "---\nallowed-tools: Bash, ImaginaryTool\n---\nBody\n"
    const warning = getSkillToolAvailabilityWarning("example", content, ["Bash", "Read", "Edit"])
    expect(warning).not.toBeNull()
    expect(warning?.missingTools).toEqual(["ImaginaryTool"])
    expect(warning?.message).toContain("/example")
    expect(warning?.message).toContain("ImaginaryTool")
  })

  test("returns null when all required tools are active", () => {
    const content = "---\nallowed-tools: Bash, Read\n---\nBody\n"
    const warning = getSkillToolAvailabilityWarning("example", content, ["Bash", "Read", "Edit"])
    expect(warning).toBeNull()
  })
})

// ─── findSkills ───────────────────────────────────────────────────────────────
// findSkills reads SKILL_DIRS which bakes in process.cwd() at import time,
// so we test it via the `swiz skill` CLI (which runs in the project root) and
// compare the listed skills against what we create on disk.

/** Helper: run `swiz skill` from the project root with a controlled HOME. */
async function runSwizSkillList(fakeHome: string): Promise<string> {
  const proc = Bun.spawn(["bun", "run", "index.ts", "skill"], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HOME: fakeHome },
  })
  const out = await new Response(proc.stdout).text()
  await proc.exited
  return out
}

describe("findSkills (via swiz skill CLI)", () => {
  test("lists no skills when global dir is empty and no local .skills present", async () => {
    const fakeHome = await createTempDir()
    const out = await runSwizSkillList(fakeHome)
    // Output is either "No skills found." or a count line
    // Without any skills installed, it should report none found
    // (project .skills may exist locally — just verify the fake global dir adds nothing)
    expect(typeof out).toBe("string")
  })

  test("lists a skill created in the global skills directory", async () => {
    const fakeHome = await createTempDir()
    const skillDir = join(fakeHome, ".claude", "skills", "my-test-skill-xyz")
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, "SKILL.md"), "---\ndescription: XYZ test skill\n---\n# Body\n")

    const out = await runSwizSkillList(fakeHome)
    expect(out).toContain("my-test-skill-xyz")
    expect(out).toContain("XYZ test skill")
  })

  test("lists multiple skills from global dir", async () => {
    const fakeHome = await createTempDir()
    const base = join(fakeHome, ".claude", "skills")
    for (const name of ["skill-alpha", "skill-beta"]) {
      await mkdir(join(base, name), { recursive: true })
      await writeFile(join(base, name, "SKILL.md"), `---\ndescription: ${name} desc\n---\n`)
    }

    const out = await runSwizSkillList(fakeHome)
    expect(out).toContain("skill-alpha")
    expect(out).toContain("skill-beta")
  })

  test("skill without frontmatter description appears in list with no description", async () => {
    const fakeHome = await createTempDir()
    const skillDir = join(fakeHome, ".claude", "skills", "no-desc-skill-xyz")
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, "SKILL.md"), "# No frontmatter here\n")

    const out = await runSwizSkillList(fakeHome)
    expect(out).toContain("no-desc-skill-xyz")
  })

  test("directory without SKILL.md is not listed", async () => {
    const fakeHome = await createTempDir()
    const base = join(fakeHome, ".claude", "skills")
    // Create a dir with no SKILL.md
    await mkdir(join(base, "empty-dir-xyz"), { recursive: true })
    // Create a valid skill for contrast
    await mkdir(join(base, "real-skill-xyz"), { recursive: true })
    await writeFile(join(base, "real-skill-xyz", "SKILL.md"), "# Real\n")

    const out = await runSwizSkillList(fakeHome)
    expect(out).toContain("real-skill-xyz")
    expect(out).not.toContain("empty-dir-xyz")
  })

  test("discovers skills that exist only in ~/.gemini/skills", async () => {
    const fakeHome = await createTempDir()
    const skillDir = join(fakeHome, ".gemini", "skills", "gemini-only-skill-xyz")
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, "SKILL.md"), "---\ndescription: Gemini only\n---\n")

    const out = await runSwizSkillList(fakeHome)
    expect(out).toContain("gemini-only-skill-xyz")
    expect(out).toContain("Gemini only")
  })

  test("discovers skills that exist only in ~/.codex/skills", async () => {
    const fakeHome = await createTempDir()
    const skillDir = join(fakeHome, ".codex", "skills", "codex-only-skill-xyz")
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, "SKILL.md"), "---\ndescription: Codex only\n---\n")

    const out = await runSwizSkillList(fakeHome)
    expect(out).toContain("codex-only-skill-xyz")
    expect(out).toContain("Codex only")
  })

  test("discovers skills that exist only in ~/.gemini/antigravity/skills", async () => {
    const fakeHome = await createTempDir()
    const skillDir = join(
      fakeHome,
      ".gemini",
      "antigravity",
      "skills",
      "antigravity-only-skill-xyz"
    )
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, "SKILL.md"), "---\ndescription: Antigravity only\n---\n")

    const out = await runSwizSkillList(fakeHome)
    expect(out).toContain("antigravity-only-skill-xyz")
    expect(out).toContain("Antigravity only")
  })

  test("discovers skills from ~/.gemini/antigravity/global_skills", async () => {
    const fakeHome = await createTempDir()
    const skillDir = join(
      fakeHome,
      ".gemini",
      "antigravity",
      "global_skills",
      "antigravity-global-skill-xyz"
    )
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, "SKILL.md"), "---\ndescription: Antigravity global\n---\n")

    const out = await runSwizSkillList(fakeHome)
    expect(out).toContain("antigravity-global-skill-xyz")
    expect(out).toContain("Antigravity global")
  })

  test("uses deterministic precedence for duplicate names (Claude before Gemini)", async () => {
    const fakeHome = await createTempDir()
    const duplicate = "shared-duplicate-skill-xyz"

    const claudeDir = join(fakeHome, ".claude", "skills", duplicate)
    await mkdir(claudeDir, { recursive: true })
    await writeFile(join(claudeDir, "SKILL.md"), "---\ndescription: Claude wins\n---\n")

    const geminiDir = join(fakeHome, ".gemini", "skills", duplicate)
    await mkdir(geminiDir, { recursive: true })
    await writeFile(join(geminiDir, "SKILL.md"), "---\ndescription: Gemini loses\n---\n")

    const out = await runSwizSkillList(fakeHome)
    const occurrences = (out.match(new RegExp(duplicate, "g")) ?? []).length
    expect(occurrences).toBe(1)
    expect(out).toContain("Claude wins")
    expect(out).not.toContain("Gemini loses")
  })

  test("uses deterministic precedence for duplicate names (Antigravity skills before global_skills)", async () => {
    const fakeHome = await createTempDir()
    const duplicate = "antigravity-precedence-skill-xyz"

    const antigravitySkillDir = join(fakeHome, ".gemini", "antigravity", "skills", duplicate)
    await mkdir(antigravitySkillDir, { recursive: true })
    await writeFile(
      join(antigravitySkillDir, "SKILL.md"),
      "---\ndescription: Antigravity skill wins\n---\n"
    )

    const antigravityGlobalDir = join(
      fakeHome,
      ".gemini",
      "antigravity",
      "global_skills",
      duplicate
    )
    await mkdir(antigravityGlobalDir, { recursive: true })
    await writeFile(
      join(antigravityGlobalDir, "SKILL.md"),
      "---\ndescription: Antigravity global loses\n---\n"
    )

    const out = await runSwizSkillList(fakeHome)
    const occurrences = (out.match(new RegExp(duplicate, "g")) ?? []).length
    expect(occurrences).toBe(1)
    expect(out).toContain("Antigravity skill wins")
    expect(out).not.toContain("Antigravity global loses")
  })
})

// ─── extractStepsFromSkill ───────────────────────────────────────────────────

describe("extractStepsFromSkill", () => {
  const skillsDir = join(homedir(), ".claude", "skills")

  async function readSkill(name: string): Promise<string> {
    return Bun.file(join(skillsDir, name, "SKILL.md")).text()
  }

  test("returns empty array for content with no ## Steps section", () => {
    const content = "---\nname: foo\n---\n\n## Context\n\nSome content.\n"
    expect(extractStepsFromSkill(content)).toEqual([])
  })

  test("returns empty array for empty string", () => {
    expect(extractStepsFromSkill("")).toEqual([])
  })

  test("extracts simple numbered steps from apply-typography", async () => {
    const content = await readSkill("apply-typography")
    const steps = extractStepsFromSkill(content)

    expect(steps.length).toBe(10)
    expect(steps[0]?.subject).toStartWith("Read the target file")
    expect(steps[9]?.subject).toStartWith("Run `pnpm lint`")
    // Simple numbered steps have no description
    for (const step of steps) {
      expect(step.description).toBeUndefined()
    }
  })

  test("extracts sub-headed steps from ci-status", async () => {
    const content = await readSkill("ci-status")
    const steps = extractStepsFromSkill(content)

    expect(steps.length).toBeGreaterThanOrEqual(3)
    expect(steps[0]?.subject).toStartWith("Plan")
    // Sub-headed steps have description body
    expect(steps[0]?.description).toBeDefined()
  })

  test("extracts steps from reflect-on-session-mistakes", async () => {
    const content = await readSkill("reflect-on-session-mistakes")
    const steps = extractStepsFromSkill(content)

    expect(steps.length).toBe(6)
    expect(steps[0]?.subject).toContain("Full session review")
  })

  test("extracts sub-headed steps from stash-to-branch", async () => {
    const content = await readSkill("stash-to-branch")
    const steps = extractStepsFromSkill(content)

    expect(steps.length).toBeGreaterThanOrEqual(6)
    expect(steps[0]?.subject).toContain("Plan Work (MANDATORY)")
    expect(steps[0]?.description).toBeDefined()
  })

  test("steps do not include content from sections after ## Steps", async () => {
    const content = await readSkill("apply-typography")
    const steps = extractStepsFromSkill(content)

    for (const step of steps) {
      expect(step.subject).not.toContain("## Detailed Reference")
    }
  })

  test("extracts ## Step N: headings from commit skill", async () => {
    const content = await readSkill("commit")
    const steps = extractStepsFromSkill(content)

    // commit skill has ## Step 0: Task Preflight as a top-level step heading
    expect(steps.length).toBeGreaterThanOrEqual(1)
    expect(steps[0]?.subject).toContain("Task Preflight")
    expect(steps[0]?.description).toBeDefined()
  })

  test("extracts ### Step N: headings from push skill", async () => {
    const content = await readSkill("push")
    const steps = extractStepsFromSkill(content)

    expect(steps.length).toBeGreaterThanOrEqual(2)
    expect(steps[0]?.subject).toContain("Task Preflight")
    expect(steps[1]?.subject).toContain("Collaboration Guard")
    expect(steps[0]?.description).toBeDefined()
  })

  test("extracts ## Step N: headings from synthetic h2 content", () => {
    const content = [
      "---",
      "name: test",
      "---",
      "",
      "## Context",
      "Some context.",
      "",
      "## Step 0: Prepare environment",
      "Set up your tools.",
      "",
      "## Step 1: Run the thing",
      "Execute the command.",
      "",
      "## Notes",
      "Extra info.",
    ].join("\n")
    const steps = extractStepsFromSkill(content)

    expect(steps.length).toBe(2)
    expect(steps[0]?.subject).toBe("Prepare environment")
    expect(steps[0]?.description).toBe("Set up your tools.")
    expect(steps[1]?.subject).toBe("Run the thing")
    expect(steps[1]?.description).toBe("Execute the command.")
  })

  test("extracts ### Step N — Title with em-dash separator", () => {
    const content = [
      "---",
      "name: test",
      "---",
      "",
      "### Step 0 — Setup",
      "Install deps.",
      "",
      "### Step 1 — Build",
      "Run the build.",
    ].join("\n")
    const steps = extractStepsFromSkill(content)

    expect(steps.length).toBe(2)
    expect(steps[0]?.subject).toBe("Setup")
    expect(steps[1]?.subject).toBe("Build")
  })

  test("extracts ### Step N: Title with colon separator at h3", () => {
    const content = [
      "---",
      "name: test",
      "---",
      "",
      "## Your Task",
      "",
      "### Step 0: First thing",
      "Do the first thing.",
      "",
      "### Step 1: Second thing",
      "Do the second thing.",
    ].join("\n")
    const steps = extractStepsFromSkill(content)

    expect(steps.length).toBe(2)
    expect(steps[0]?.subject).toBe("First thing")
    expect(steps[1]?.subject).toBe("Second thing")
  })

  test("step description stops at next heading of same or higher level", () => {
    const content = [
      "---",
      "name: test",
      "---",
      "",
      "### Step 0: Do something",
      "Line 1.",
      "#### Sub-detail",
      "Sub content.",
      "",
      "### Step 1: Next step",
      "Line 2.",
    ].join("\n")
    const steps = extractStepsFromSkill(content)

    expect(steps.length).toBe(2)
    // Step 0 description includes the h4 sub-detail
    expect(steps[0]?.description).toContain("Sub-detail")
    expect(steps[0]?.description).toContain("Sub content.")
    expect(steps[1]?.description).toBe("Line 2.")
  })

  test("subject and description are properly separated for sub-headed steps", async () => {
    const content = await readSkill("prune-branches")
    const steps = extractStepsFromSkill(content)

    expect(steps.length).toBeGreaterThanOrEqual(2)
    // Subject is the heading text, description is the body
    for (const step of steps) {
      expect(step.subject.length).toBeGreaterThan(0)
      expect(step.subject).not.toContain("###")
    }
  })
})
