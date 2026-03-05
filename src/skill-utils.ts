import { existsSync } from "node:fs"
import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { getAllProviderSkillDirs } from "./provider-utils.ts"

// Skills live in .skills/ (project-local) and provider-specific global directories.
// Each skill is a directory containing SKILL.md.
export const SKILL_DIRS = [join(process.cwd(), ".skills"), ...getAllProviderSkillDirs()]
// Deterministic precedence for duplicate names: first directory wins.
export const SKILL_PRECEDENCE = [...SKILL_DIRS]

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

export interface SkillConflictEntry {
  dir: string
  path: string
}

export interface SkillConflict {
  name: string
  active: SkillConflictEntry
  overridden: SkillConflictEntry[]
}

export async function findSkills(): Promise<SkillInfo[]> {
  const skills: SkillInfo[] = []
  const seen = new Set<string>()

  for (const dir of SKILL_PRECEDENCE) {
    let entries: import("node:fs").Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }

    const directoryNames = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b))

    for (const name of directoryNames) {
      if (seen.has(name)) continue

      const skillPath = join(dir, name, "SKILL.md")
      const file = Bun.file(skillPath)
      if (!(await file.exists())) continue

      const content = await file.text()
      const description = parseFrontmatterField(content, "description") ?? ""

      skills.push({
        name,
        description,
        source: dir === SKILL_PRECEDENCE[0] ? "local" : "global",
        path: skillPath,
      })
      seen.add(name)
    }
  }

  return skills
}

export async function findSkillConflicts(
  skillDirs: string[] = SKILL_PRECEDENCE
): Promise<SkillConflict[]> {
  const byName = new Map<string, SkillConflictEntry[]>()

  for (const dir of skillDirs) {
    let entries: import("node:fs").Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }

    const directoryNames = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b))

    for (const name of directoryNames) {
      const skillPath = join(dir, name, "SKILL.md")
      if (!(await Bun.file(skillPath).exists())) continue
      const existing = byName.get(name) ?? []
      existing.push({ dir, path: skillPath })
      byName.set(name, existing)
    }
  }

  const conflicts: SkillConflict[] = []
  const sortedNames = [...byName.keys()].sort((a, b) => a.localeCompare(b))
  for (const name of sortedNames) {
    const entries = byName.get(name) ?? []
    if (entries.length <= 1) continue
    const [active, ...overridden] = entries
    if (!active) continue
    conflicts.push({ name, active, overridden })
  }

  return conflicts
}
