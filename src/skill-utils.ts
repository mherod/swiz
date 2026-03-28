import { existsSync } from "node:fs"
import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { orderBy, uniq } from "lodash-es"
import { AGENTS } from "./agents.ts"
import { resolveCwd } from "./cwd.ts"
import { detectCurrentAgent } from "./detect.ts"
import { getAllProviderSkillDirs } from "./provider-utils.ts"

/** Matches directories renamed by swiz to disable a skill, e.g. "my-skill.disabled-by-swiz-20260312143027". */
const DISABLED_BY_SWIZ_RE = /\.disabled-by-swiz-\d{14}$/

// Skills live in .skills/ (project-local) and provider-specific global directories.
// Each skill is a directory containing SKILL.md.
export const SKILL_DIRS = [join(resolveCwd(), ".skills"), ...getAllProviderSkillDirs()]
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
 * Return actionable advice that references a skill.
 *
 * When the skill exists, the skill directive (`withSkill`) is prepended to the
 * concrete manual steps (`withoutSkill`) so the reader gets both the quick
 * invocation shortcut AND the full step-by-step guide.
 * When the skill is absent, only `withoutSkill` is returned.
 *
 * @param skill - The skill name without leading slash (e.g. "commit")
 * @param withSkill - Skill invocation directive shown when the skill exists
 * @param withoutSkill - Concrete manual steps, always shown
 */
export function skillAdvice(skill: string, withSkill: string, withoutSkill: string): string {
  if (skillExists(skill)) {
    return `${withSkill}\n\n${withoutSkill}`
  }
  return withoutSkill
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

// ─── Skill tool availability checks ──────────────────────────────────────────

function normalizeToolSpec(raw: string): string | null {
  const trimmed = raw.trim().replace(/^["']|["']$/g, "")
  if (!trimmed) return null
  const base = trimmed.split("(")[0]?.trim() ?? ""
  return base || null
}

function parseAllowedToolsValue(value: string): string[] {
  return value
    .split(",")
    .map((part) => normalizeToolSpec(part))
    .filter((name): name is string => Boolean(name))
}

/**
 * Extract required tools from SKILL.md frontmatter `allowed-tools`.
 * Supports both inline and YAML-list forms.
 */
function parseYamlBlockItems(
  lines: string[],
  startIdx: number
): { tools: string[]; endIdx: number } {
  const tools: string[] = []
  let j = startIdx
  while (j < lines.length) {
    const item = (lines[j] ?? "").match(/^\s*-\s*(.+)\s*$/)
    if (!item?.[1]) break
    const normalized = normalizeToolSpec(item[1])
    if (normalized) tools.push(normalized)
    j++
  }
  return { tools, endIdx: j }
}

function processAllowedToolsLine(
  line: string,
  lines: string[],
  i: number,
  tools: string[]
): number {
  const inline = line.match(/^allowed-tools\s*:\s*(.+)\s*$/)
  if (inline?.[1]) {
    tools.push(...parseAllowedToolsValue(inline[1]))
    return i
  }
  if (!line.match(/^allowed-tools\s*:\s*$/)) return i
  const block = parseYamlBlockItems(lines, i + 1)
  tools.push(...block.tools)
  return block.endIdx - 1
}

export function extractMandatedSkillTools(content: string): string[] {
  const match = content.match(/^---\n([\s\S]*?)\n---(?:[ \t]*\n?)/)
  if (!match?.[1]) return []

  const lines = match[1].split("\n")
  const tools: string[] = []

  for (let i = 0; i < lines.length; i++) {
    i = processAllowedToolsLine(lines[i] ?? "", lines, i, tools)
  }

  return uniq(tools)
}

function detectActiveSkillTools(): string[] {
  const active = detectCurrentAgent()
  if (!active) return []

  const tools = new Set<string>()

  // Agent-specific aliases are the primary invocation names.
  for (const alias of Object.values(active.toolAliases)) tools.add(alias)

  // Include canonical names that map for this agent (identity for Claude, helpful for mixed skills).
  for (const canonical of Object.keys(active.toolAliases)) tools.add(canonical)

  // Claude uses canonical names directly and has an empty alias table.
  if (active.id === "claude") {
    for (const agent of AGENTS) {
      for (const canonical of Object.keys(agent.toolAliases)) tools.add(canonical)
    }
  }

  return orderBy([...tools], [(tool) => tool], ["asc"])
}

export interface SkillToolAvailabilityWarning {
  missingTools: string[]
  activeTools: string[]
  requiredTools: string[]
  message: string
}

/**
 * Check whether the current runtime can satisfy a skill's mandated tools.
 * Returns null when no warning is needed.
 */
export function getSkillToolAvailabilityWarning(
  skillName: string,
  content: string,
  activeTools?: string[]
): SkillToolAvailabilityWarning | null {
  const requiredTools = extractMandatedSkillTools(content)
  if (requiredTools.length === 0) return null

  const available = (activeTools ?? detectActiveSkillTools()).map((t) => t.trim()).filter(Boolean)
  if (available.length === 0) return null
  const availableSet = new Set(available)

  const missingTools = requiredTools.filter((tool) => !availableSet.has(tool))
  if (missingTools.length === 0) return null

  return {
    missingTools,
    activeTools: available,
    requiredTools,
    message:
      `⚠ Skill tool availability warning for /${skillName}: ` +
      `required tool(s) not active in this session: ${missingTools.join(", ")}. ` +
      `Active tool list: ${available.join(", ")}.`,
  }
}

// ─── Step extraction ────────────────────────────────────────────────────────

export interface SkillStep {
  subject: string
  description?: string
}

/**
 * Extract steps from a `## Steps` section body.
 * Handles simple numbered lists (`1. Do X`) and sub-headed formats (`### 1. Title`).
 */
function extractFromStepsSection(body: string): SkillStep[] {
  const lines = body.split("\n")
  const steps: SkillStep[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ""

    // Match `### N. Title` (sub-headed format)
    const subHeaded = line.match(/^###\s+\d+\.\s*(.+)/)
    if (subHeaded?.[1]) {
      const descLines: string[] = []
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j] ?? ""
        // Stop at next step heading or numbered item
        if (next.match(/^###\s+\d+\./) || next.match(/^\d+\.\s+/)) break
        descLines.push(next)
        i = j
      }
      const desc = descLines.join("\n").trim() || undefined
      steps.push({ subject: subHeaded[1].trim(), description: desc })
      continue
    }

    // Match `N. Step text` at the start of a line (simple numbered)
    const numbered = line.match(/^\d+\.\s+(.+)/)
    if (numbered?.[1]) {
      steps.push({ subject: numbered[1].trim() })
    }
  }

  return steps
}

/**
 * Matches step headings at any markdown heading level (##, ###, ####):
 *   `## Step 0: Title`, `### Step 1 — Title`, `### Step 2: Title`
 * Captures the heading level (number of #) and the title after the separator.
 */
const STEP_HEADING_RE = /^(#{2,4})\s+Step\s+\d+\s*[-:—]\s*(.+)/

/**
 * Extract `Step N:` / `Step N —` headings scattered throughout the document.
 * Handles h2, h3, and h4 levels. Collects the body between each step heading
 * and the next heading at the same or higher level as description.
 */
function extractFromStepHeadings(stripped: string): SkillStep[] {
  const lines = stripped.split("\n")
  const steps: SkillStep[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ""
    const match = line.match(STEP_HEADING_RE)
    if (!match?.[1] || !match[2]) continue

    const level = match[1].length // number of # characters
    const descLines: string[] = []
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j] ?? ""
      // Stop at next heading at same or higher level
      const headingMatch = next.match(/^(#{2,6})\s/)
      if (headingMatch && headingMatch[1]!.length <= level) break
      descLines.push(next)
      i = j
    }
    const desc = descLines.join("\n").trim() || undefined
    steps.push({ subject: match[2].trim(), description: desc })
  }

  return steps
}

/**
 * Extract numbered steps from a skill document.
 *
 * Strategy (in priority order):
 * 1. A dedicated `## Steps` section with numbered items or `### N.` sub-headings.
 * 2. Top-level `## Step N: Title` headings scattered throughout the document.
 *
 * Returns structured steps with subject and optional description body.
 */
export function extractStepsFromSkill(content: string): SkillStep[] {
  const stripped = stripFrontmatter(content)

  // Strategy 1: dedicated ## Steps section
  const stepsMatch = stripped.match(/^## Steps\s*\n([\s\S]*?)(?=\n## (?!#))/m)
  const body = stepsMatch?.[1] ?? stripped.match(/^## Steps\s*\n([\s\S]*)/m)?.[1]
  if (body) return extractFromStepsSection(body)

  // Strategy 2: ## Step N: Title headings
  return extractFromStepHeadings(stripped)
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

    const directoryNames = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    const orderedDirectoryNames = orderBy(directoryNames, [(name) => name], ["asc"])

    for (const name of orderedDirectoryNames) {
      if (seen.has(name)) continue
      if (DISABLED_BY_SWIZ_RE.test(name)) continue

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

async function scanSkillDir(dir: string, byName: Map<string, SkillConflictEntry[]>): Promise<void> {
  let entries: import("node:fs").Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  const directoryNames = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  for (const name of orderBy(directoryNames, [(n) => n], ["asc"])) {
    if (DISABLED_BY_SWIZ_RE.test(name)) continue
    const skillPath = join(dir, name, "SKILL.md")
    if (!(await Bun.file(skillPath).exists())) continue
    const existing = byName.get(name) ?? []
    existing.push({ dir, path: skillPath })
    byName.set(name, existing)
  }
}

export async function findSkillConflicts(
  skillDirs: string[] = SKILL_PRECEDENCE
): Promise<SkillConflict[]> {
  const byName = new Map<string, SkillConflictEntry[]>()
  for (const dir of skillDirs) await scanSkillDir(dir, byName)

  const conflicts: SkillConflict[] = []
  for (const name of orderBy([...byName.keys()], [(n) => n], ["asc"])) {
    const entries = byName.get(name) ?? []
    if (entries.length <= 1) continue
    const [active, ...overridden] = entries
    if (!active) continue
    conflicts.push({ name, active, overridden })
  }
  return conflicts
}
