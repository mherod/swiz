import { existsSync } from "node:fs"
import { readdir } from "node:fs/promises"
import { join } from "node:path"

// Skills live in .skills/ (project-local) or ~/.claude/skills/ (global).
// Each skill is a directory containing SKILL.md.
export const SKILL_DIRS = [
  join(process.cwd(), ".skills"),
  join(process.env.HOME ?? "~", ".claude", "skills"),
]

// ─── Skill existence (sync, cached) ─────────────────────────────────────────

const _skillCache = new Map<string, boolean>()

/** Check if a skill exists in any of the skill directories. Cached per process. */
export function skillExists(name: string): boolean {
  if (!name.trim()) return false
  const cached = _skillCache.get(name)
  if (cached !== undefined) return cached

  const found = SKILL_DIRS.some((dir) => existsSync(join(dir, name, "SKILL.md")))
  _skillCache.set(name, found)
  return found
}

/**
 * Return actionable advice that references a skill if it exists,
 * or falls back to concrete manual steps.
 *
 * @param skill - The skill name without leading slash (e.g. "commit")
 * @param withSkill - Message to use when the skill exists (may include `/<skill>`)
 * @param withoutSkill - Fallback message with concrete manual steps
 */
export function skillAdvice(skill: string, withSkill: string, withoutSkill: string): string {
  return skillExists(skill) ? withSkill : withoutSkill
}

// ─── Frontmatter parsing ─────────────────────────────────────────────────────

export function parseFrontmatterField(content: string, field: string): string | null {
  const match = content.match(new RegExp(`^---[\\s\\S]*?^${field}:\\s*(.+)$[\\s\\S]*?^---`, "m"))
  return match?.[1]?.trim() ?? null
}

export function stripFrontmatter(content: string): string {
  // Use [ \t]* (not \s*) to avoid consuming the blank line that may follow the closing ---
  return content.replace(/^---[\s\S]*?^---[ \t]*\n?/m, "")
}

// ─── Skill listing (async) ───────────────────────────────────────────────────

export interface SkillInfo {
  name: string
  description: string
  source: "local" | "global"
  path: string
}

export async function findSkills(): Promise<SkillInfo[]> {
  const skills: SkillInfo[] = []

  for (const dir of SKILL_DIRS) {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue

      const skillPath = join(dir, entry.name, "SKILL.md")
      const file = Bun.file(skillPath)
      if (!(await file.exists())) continue

      const content = await file.text()
      const description = parseFrontmatterField(content, "description") ?? ""

      skills.push({
        name: entry.name,
        description,
        source: dir === SKILL_DIRS[0] ? "local" : "global",
        path: skillPath,
      })
    }
  }

  return skills
}
