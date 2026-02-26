import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stripFrontmatter, parseFrontmatterField } from "./skill.ts";

// ─── parseFrontmatterField unit tests ────────────────────────────────────────

describe("parseFrontmatterField", () => {
  test("extracts a simple string field", () => {
    const content = "---\ndescription: A test skill\n---\n# Body\n";
    expect(parseFrontmatterField(content, "description")).toBe("A test skill");
  });

  test("trims trailing whitespace from extracted value", () => {
    const content = "---\ndescription: Padded value   \n---\n";
    expect(parseFrontmatterField(content, "description")).toBe("Padded value");
  });

  test("returns null when field is absent", () => {
    const content = "---\nauthor: Alice\n---\n# Body\n";
    expect(parseFrontmatterField(content, "description")).toBeNull();
  });

  test("returns null when content has no frontmatter", () => {
    const content = "# Just a heading\n\nNo frontmatter here.\n";
    expect(parseFrontmatterField(content, "description")).toBeNull();
  });

  test("handles field with no space after colon (key:value)", () => {
    const content = "---\ndescription:Compact value\n---\n";
    expect(parseFrontmatterField(content, "description")).toBe("Compact value");
  });

  test("extracts field with quoted value", () => {
    const content = "---\nglobs: \"*.ts, *.tsx\"\n---\n";
    expect(parseFrontmatterField(content, "globs")).toBe("\"*.ts, *.tsx\"");
  });

  test("extracts first matching field when multiple fields exist", () => {
    const content = "---\ndescription: First\nglobs: \"*.ts\"\ntags: testing\n---\n";
    expect(parseFrontmatterField(content, "description")).toBe("First");
    expect(parseFrontmatterField(content, "globs")).toBe("\"*.ts\"");
    expect(parseFrontmatterField(content, "tags")).toBe("testing");
  });

  test("returns null when frontmatter has no closing ---", () => {
    const content = "---\ndescription: No close\n# Body\n";
    expect(parseFrontmatterField(content, "description")).toBeNull();
  });
});

// ─── stripFrontmatter unit tests ─────────────────────────────────────────────

describe("stripFrontmatter", () => {
  test("returns content unchanged when no frontmatter present", () => {
    const content = "# My Skill\n\nDo something useful.\n";
    expect(stripFrontmatter(content)).toBe(content);
  });

  test("strips well-formed frontmatter block", () => {
    const content =
      "---\ndescription: A test skill\nglobs: \"*.ts\"\n---\n# Body\n\nContent here.\n";
    expect(stripFrontmatter(content)).toBe("# Body\n\nContent here.\n");
  });

  test("strips frontmatter when body starts immediately after closing ---", () => {
    const content = "---\nkey: value\n---\nBody starts here.";
    expect(stripFrontmatter(content)).toBe("Body starts here.");
  });

  test("returns empty string when file is only frontmatter", () => {
    const content = "---\ndescription: Only meta\n---\n";
    expect(stripFrontmatter(content)).toBe("");
  });

  test("preserves content after frontmatter including trailing newlines", () => {
    const content = "---\nkey: val\n---\n\nLine 1.\n\nLine 2.\n";
    expect(stripFrontmatter(content)).toBe("\nLine 1.\n\nLine 2.\n");
  });

  test("does not strip when only an opening --- exists (malformed)", () => {
    // No closing ---, so the regex should not match
    const content = "---\ndescription: no close\n# Body\n";
    expect(stripFrontmatter(content)).toBe(content);
  });

  test("does not strip when only a closing --- exists (no opening)", () => {
    const content = "# Header\nsome content\n---\nafter\n";
    // --- appears in the middle but there's no opening ---
    // The regex anchors opening to line start with ^--- at start of string area
    // Since there's no opening block, content is unchanged
    expect(stripFrontmatter(content)).toBe(content);
  });

  test("does not strip --- separators that appear mid-document", () => {
    const content = "# Title\n\nParagraph one.\n\n---\n\nParagraph two.\n";
    expect(stripFrontmatter(content)).toBe(content);
  });

  test("strips only the first frontmatter block when multiple --- pairs exist", () => {
    const content = "---\nfirst: yes\n---\nBody\n---\nsecond: yes\n---\nMore\n";
    // Only the leading frontmatter block should be stripped
    expect(stripFrontmatter(content)).toBe("Body\n---\nsecond: yes\n---\nMore\n");
  });

  test("handles empty string without throwing", () => {
    expect(stripFrontmatter("")).toBe("");
  });

  test("handles frontmatter-only file with no trailing newline", () => {
    const content = "---\nkey: val\n---";
    // After stripping, remaining content is empty
    expect(stripFrontmatter(content)).toBe("");
  });
});

// ─── CLI --no-front-matter flag integration tests ────────────────────────────

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await rm(dir, { recursive: true, force: true });
  }
});

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "swiz-skill-test-"));
  tempDirs.push(dir);
  return dir;
}

/** Write a skill with frontmatter to a temp .skills dir and run swiz skill against it. */
async function runSkillCmd(
  skillContent: string,
  extraArgs: string[] = []
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const fakeHome = await createTempDir();
  const skillName = "test-skill";
  // skill.ts looks in $HOME/.claude/skills/<name>/SKILL.md
  const skillDir = join(fakeHome, ".claude", "skills", skillName);
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), skillContent);
  const skillsDir = fakeHome;

  const proc = Bun.spawn(
    ["bun", "run", "index.ts", "skill", ...extraArgs, skillName],
    {
      cwd: process.cwd(),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HOME: skillsDir },
    }
  );
  proc.stdin.end();
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  await proc.exited;
  return { stdout, stderr, exitCode: proc.exitCode };
}

describe("swiz skill --no-front-matter", () => {
  const SKILL_WITH_FM =
    "---\ndescription: Test skill\nglobs: \"*.ts\"\n---\n# Skill Body\n\nDo something.\n";

  test("omits frontmatter block from output", async () => {
    const { stdout } = await runSkillCmd(SKILL_WITH_FM, ["--no-front-matter"]);
    expect(stdout).not.toContain("---");
    expect(stdout).not.toContain("description:");
    expect(stdout).toContain("# Skill Body");
    expect(stdout).toContain("Do something.");
  });

  test("without flag, frontmatter is included in output", async () => {
    const { stdout } = await runSkillCmd(SKILL_WITH_FM);
    expect(stdout).toContain("description: Test skill");
    expect(stdout).toContain("# Skill Body");
  });

  test("--no-front-matter on skill without frontmatter outputs content unchanged", async () => {
    const content = "# Plain Skill\n\nNo frontmatter here.\n";
    const { stdout } = await runSkillCmd(content, ["--no-front-matter"]);
    expect(stdout).toContain("# Plain Skill");
    expect(stdout).toContain("No frontmatter here.");
  });

  test("--raw and --no-front-matter can be combined", async () => {
    // --raw skips inline command expansion; --no-front-matter still strips the header
    const content = "---\ndescription: raw test\n---\n# Body\n\nContent.\n";
    const { stdout } = await runSkillCmd(content, ["--raw", "--no-front-matter"]);
    expect(stdout).not.toContain("description:");
    expect(stdout).toContain("# Body");
  });

  test("flag order does not matter: --no-front-matter before skill name", async () => {
    const { stdout } = await runSkillCmd(SKILL_WITH_FM, ["--no-front-matter"]);
    expect(stdout).toContain("# Skill Body");
    expect(stdout).not.toContain("description:");
  });

  test("exits with code 0 on success", async () => {
    const { exitCode } = await runSkillCmd(SKILL_WITH_FM, ["--no-front-matter"]);
    expect(exitCode).toBe(0);
  });
});
