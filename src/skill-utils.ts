import { existsSync } from "node:fs"
import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { orderBy, uniq } from "lodash-es"
import { AGENTS, type AgentDef, agentSupportsTool } from "./agents.ts"
import { resolveCwd } from "./cwd.ts"
import { detectCurrentAgent } from "./detect.ts"
import { getAllProviderSkillDirs } from "./provider-utils.ts"
import { stripQuotes } from "./utils/quoted-string.ts"

// Skills live in .skills/ (project-local) and provider-specific global directories.
// Each skill is a directory containing SKILL.md.
export const SKILL_DIRS = [join(resolveCwd(), ".skills"), ...getAllProviderSkillDirs()]
// Deterministic precedence for duplicate names: first directory wins.
export const SKILL_PRECEDENCE = [...SKILL_DIRS]

// ─── Skill existence (sync, cached) ─────────────────────────────────────────

const _skillCache = new Map<string, boolean>()

/** Clear the internal skill existence cache. Primarily for testing. */
export function clearSkillCache(): void {
  _skillCache.clear()
}

/** Check if a skill exists in any of the skill directories. Cached per process. */
export function skillExists(name: string): boolean {
  if (!name.trim()) return false
  const cached = _skillCache.get(name)
  if (cached !== undefined) return cached

  const active = detectCurrentAgent()
  if (!active || !agentSupportsTool(active, "Skill")) {
    _skillCache.set(name, false)
    return false
  }

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
  const trimmed = stripQuotes(raw)
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

/** Extra tool tokens that appear in Claude-style skills but may not appear in every agent's alias table. */
const EXTRA_SKILL_TOOL_SCAN_TOKENS: readonly string[] = [
  "TaskList",
  "WebSearch",
  "WebFetch",
  "MultiEdit",
  "ListMcpResources",
]

let _canonicalToolScanSet: Set<string> | null = null

function buildCanonicalToolScanSet(): Set<string> {
  const s = new Set<string>()
  for (const a of AGENTS) {
    for (const k of Object.keys(a.toolAliases)) s.add(k)
    for (const v of Object.values(a.toolAliases)) {
      if (/^[A-Za-z][A-Za-z0-9_]*$/.test(v)) s.add(v)
    }
  }
  s.add("Skill")
  for (const t of EXTRA_SKILL_TOOL_SCAN_TOKENS) s.add(t)
  return s
}

function getCanonicalToolScanSet(): Set<string> {
  if (_canonicalToolScanSet === null) _canonicalToolScanSet = buildCanonicalToolScanSet()
  return _canonicalToolScanSet
}

/**
 * Find tool-like tokens referenced in skill body text (backticks and `Name(` invocations).
 * Only names present in the shared scan set (agent alias keys/values plus common extras) are returned.
 */
export function extractReferencedToolsFromSkillText(body: string): string[] {
  const scan = getCanonicalToolScanSet()
  const found = new Set<string>()

  for (const m of body.matchAll(/`([A-Za-z][A-Za-z0-9_]*)`/g)) {
    const name = m[1]
    if (name && scan.has(name)) found.add(name)
  }

  for (const m of body.matchAll(/\b([A-Za-z][A-Za-z0-9_]*)\s*\(/g)) {
    const name = m[1]
    if (name && scan.has(name)) found.add(name)
  }

  return orderBy([...found], [(t) => t], ["asc"])
}

/**
 * When printing a skill inside a detected agent runtime, append a footer if the skill references
 * tools that {@link agentSupportsTool} reports as unavailable for that agent.
 *
 * Uses {@link AgentDef.toolAliases} for replacement hints when the unsupported token is a known
 * canonical name with a mapped runtime tool. Otherwise explains that the reader should adapt via
 * planning and step-by-step reasoning.
 */
export function buildSkillAgentToolEnvironmentFooter(
  agent: AgentDef,
  referencedTools: string[]
): string | null {
  if (agent.id === "claude") return null

  const unsupported = orderBy(
    uniq(referencedTools.filter((t) => !agentSupportsTool(agent, t))),
    [(t) => t],
    ["asc"]
  )
  if (unsupported.length === 0) return null

  const lines: string[] = []
  for (const t of unsupported) {
    lines.push(
      `- \`${t}\` → not exposed under that name for ${agent.name} in Swiz's agent tool table; treat it as a capability goal and carry out equivalent steps with your available tools.`
    )
  }

  const aliasEntries = Object.entries(agent.toolAliases).filter(([c, m]) => c !== m)
  const mappingLine =
    aliasEntries.length > 0
      ? `\n\n_Swiz Claude-style → ${agent.name} tool names: ${aliasEntries.map(([c, m]) => `\`${c}\`→\`${m}\``).join(", ")}._`
      : ""

  return (
    `\n\n---\n\n**${agent.name}:** This skill references tool name(s) that are not exposed under those exact names in your environment ` +
    `(names that already map for ${agent.name} in Swiz's agent tool table are omitted):\n` +
    `${lines.join("\n")}` +
    mappingLine +
    `\n\n_Any references to tools your session does not provide should be satisfied with best-effort planning and explicit step-by-step reasoning._\n`
  )
}

function detectActiveSkillTools(): string[] {
  const active = detectCurrentAgent()
  if (!active) return []

  const tools = new Set<string>()

  // Agent-specific aliases are the primary invocation names.
  for (const alias of Object.values(active.toolAliases)) tools.add(alias)

  // Include canonical names that map for this agent.
  for (const canonical of Object.keys(active.toolAliases)) {
    if (agentSupportsTool(active, canonical)) {
      tools.add(canonical)
    }
  }

  // Claude uses canonical names directly and supports all tools by default.
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
function collectDescriptionLines(
  lines: string[],
  startIdx: number,
  stopRe: RegExp
): { desc: string | undefined; endIdx: number } {
  const descLines: string[] = []
  let endIdx = startIdx
  for (let j = startIdx; j < lines.length; j++) {
    if (stopRe.test(lines[j] ?? "")) break
    descLines.push(lines[j] ?? "")
    endIdx = j
  }
  return { desc: descLines.join("\n").trim() || undefined, endIdx }
}

function extractFromStepsSection(body: string): SkillStep[] {
  const lines = body.split("\n")
  const steps: SkillStep[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ""

    const subHeaded = line.match(/^###\s+\d+\.\s*(.+)/) // sub-headed step format
    if (subHeaded?.[1]) {
      const { desc, endIdx } = collectDescriptionLines(lines, i + 1, /^###\s+\d+\.|^\d+\.\s+/)
      i = endIdx
      steps.push({ subject: subHeaded[1].trim(), description: desc })
      continue
    }

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
function collectUntilHeadingAtLevel(
  lines: string[],
  startIdx: number,
  maxLevel: number
): { desc: string | undefined; endIdx: number } {
  const descLines: string[] = []
  let endIdx = startIdx
  for (let j = startIdx; j < lines.length; j++) {
    const headingMatch = (lines[j] ?? "").match(/^(#{2,6})\s/)
    if (headingMatch && headingMatch[1]!.length <= maxLevel) break
    descLines.push(lines[j] ?? "")
    endIdx = j
  }
  return { desc: descLines.join("\n").trim() || undefined, endIdx }
}

function extractFromStepHeadings(stripped: string): SkillStep[] {
  const lines = stripped.split("\n")
  const steps: SkillStep[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ""
    const match = line.match(STEP_HEADING_RE)
    if (!match?.[1] || !match[2]) continue

    const { desc, endIdx } = collectUntilHeadingAtLevel(lines, i + 1, match[1].length)
    i = endIdx
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

// ─── Step quality filter ────────────────────────────────────────────────────

/** Backtick-wrapped content dominates the subject (shell command as title). */
const BACKTICK_DOMINANT_RE = /^`[^`]+`/

/**
 * Filter out low-quality steps that don't make good task subjects.
 *
 * Rejects:
 * - Single-word subjects (too vague: "Plan", "Finalize")
 * - Subjects dominated by backtick-wrapped shell commands
 * - Subjects shorter than 3 words
 */
export function filterQualitySteps(steps: SkillStep[]): SkillStep[] {
  return steps.filter((step) => {
    const subject = step.subject.trim()
    // Strip markdown formatting for word counting
    const plain = subject.replace(/`[^`]*`/g, "").trim()
    const wordCount = plain.split(/\s+/).filter(Boolean).length
    if (wordCount < 2) return false
    if (BACKTICK_DOMINANT_RE.test(subject)) return false
    return true
  })
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
