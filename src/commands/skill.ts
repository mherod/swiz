import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Command } from "../types.ts";

const SKILL_DIRS = [
  resolve(".skills"),
  join(process.env.HOME ?? "~", ".claude", "skills"),
];

const INLINE_CMD_RE = /!\`([^`]+)\`/g;

interface SkillInfo {
  name: string;
  description: string;
  source: string;
  path: string;
}

async function findSkills(): Promise<SkillInfo[]> {
  const skills: SkillInfo[] = [];

  for (const dir of SKILL_DIRS) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const skillPath = join(dir, entry.name, "SKILL.md");
      const file = Bun.file(skillPath);
      if (!(await file.exists())) continue;

      const content = await file.text();
      const description = parseFrontmatterField(content, "description") ?? "";

      skills.push({
        name: entry.name,
        description,
        source: dir === SKILL_DIRS[0] ? "local" : "global",
        path: skillPath,
      });
    }
  }

  return skills;
}

function parseFrontmatterField(content: string, field: string): string | null {
  const match = content.match(
    new RegExp(`^---[\\s\\S]*?^${field}:\\s*(.+)$[\\s\\S]*?^---`, "m")
  );
  return match?.[1]?.trim() ?? null;
}

async function listSkills() {
  const skills = await findSkills();
  if (skills.length === 0) {
    console.log("No skills found.");
    return;
  }

  console.log(`\n  ${skills.length} skills available\n`);

  const maxName = Math.max(...skills.map((s) => s.name.length), 8);
  for (const skill of skills) {
    const tag = skill.source === "local" ? " (local)" : "";
    const desc = skill.description ? ` ${skill.description}` : "";
    console.log(`    ${skill.name.padEnd(maxName + 2)}${desc}${tag}`);
  }
  console.log();
}

async function expandInlineCommands(content: string): Promise<string> {
  const matches = [...content.matchAll(INLINE_CMD_RE)];
  if (matches.length === 0) return content;

  const results = await Promise.all(
    matches.map(async (m) => {
      const cmd = m[1]!;
      try {
        const proc = Bun.spawn(["sh", "-c", cmd], {
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, PATH: process.env.PATH },
        });
        const stdout = await new Response(proc.stdout).text();
        await proc.exited;
        return stdout.trim();
      } catch {
        return `[error running: ${cmd}]`;
      }
    })
  );

  let i = 0;
  return content.replace(INLINE_CMD_RE, () => results[i++]!);
}

function stripFrontmatter(content: string): string {
  return content.replace(/^---[\s\S]*?^---\s*\n?/m, "");
}

async function readSkill(name: string, raw: boolean, noFrontMatter: boolean) {
  const skills = await findSkills();
  const skill = skills.find((s) => s.name === name);

  if (!skill) {
    throw new Error(`Skill not found: ${name}\nRun "swiz skill" to list available skills.`);
  }

  let content = await Bun.file(skill.path).text();
  if (!raw) {
    content = await expandInlineCommands(content);
  }
  if (noFrontMatter) {
    content = stripFrontmatter(content);
  }
  console.log(content);
}

export const skillCommand: Command = {
  name: "skill",
  description: "Read and list skills",
  usage: "swiz skill [--raw] [--no-front-matter] [skill-name]",
  async run(args) {
    const raw = args.includes("--raw");
    const noFrontMatter = args.includes("--no-front-matter");
    const flags = new Set(["--raw", "--no-front-matter"]);
    const name = args.find((a) => !flags.has(a));
    if (!name) {
      await listSkills();
    } else {
      await readSkill(name, raw, noFrontMatter);
    }
  },
};
