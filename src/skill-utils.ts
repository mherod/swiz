import { existsSync, statSync } from "node:fs"
import { readdir, stat } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { orderBy, uniq } from "lodash-es"
import {
  agentHasTaskToolsForHookPayload,
  detectCurrentAgentFromHookPayload,
} from "./agent-paths.ts"
import {
  AGENTS,
  type AgentDef,
  type AgentToolCapabilityInventory,
  agentSupportsTool,
  readAgentToolCapabilityInventoryFromEnv,
} from "./agents.ts"
import { resolveSpawnCwd } from "./cwd.ts"
import { detectCurrentAgent } from "./detect.ts"
import { findGitWorkTree } from "./git-helpers.ts"
import { getHomeDir } from "./home.ts"
import { projectKeyFromCwd } from "./project-key.ts"
import { getProviderAdapter } from "./provider-adapters.ts"
import { getAllProviderSkillDirs } from "./provider-utils.ts"
import {
  DEFAULT_SKILL_RECENCY_MAX_AGE_MINUTES,
  DEFAULT_SKILL_RECENCY_MAX_TURNS,
  resolveNumericSetting,
} from "./settings/resolution.ts"
import {
  type CurrentSessionUsageRecencyOptions,
  computeSummaryFromSessionLines,
  formatCurrentSessionUsageWindow,
  getRecentSkillsUsedForCurrentSession,
  getRecentToolsUsedForCurrentSession,
  hasAgentDirectlyReadOrInvokedSkill,
} from "./transcript-summary.ts"
import { stripQuotes } from "./utils/quoted-string.ts"

type HookPayload = Parameters<typeof detectCurrentAgentFromHookPayload>[0]

/** Resolve the standard cross-agent user skill directory. */
export function getAgentsSkillDir(homeDir: string = getHomeDir()): string {
  return join(homeDir, ".agents", "skills")
}

/** Resolve the legacy direct-root shared skill directory. */
export function getLegacyAgentsSkillDir(homeDir: string = getHomeDir()): string {
  return join(homeDir, ".agents")
}

/** Resolve repository-scoped `.agents/skills` roots from nearest to furthest. */
export function getProjectAgentsSkillDirs(cwd: string = process.cwd()): string[] {
  const start = resolve(cwd)
  const repositoryRoot = findGitWorkTree(start)
  if (!repositoryRoot) return [join(start, ".agents", "skills")]

  const dirs: string[] = []
  let current = start
  while (true) {
    dirs.push(join(current, ".agents", "skills"))
    if (current === repositoryRoot) break
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return dirs
}

/** Resolve shared roots in discovery order: project ancestors, user standard, legacy. */
export function getAgentsSkillDirs(
  cwd: string = process.cwd(),
  homeDir: string = getHomeDir()
): string[] {
  return uniq([
    ...getProjectAgentsSkillDirs(cwd),
    getAgentsSkillDir(homeDir),
    getLegacyAgentsSkillDir(homeDir),
  ])
}

/** Whether a directory is a standard or legacy shared Agents skill root. */
export function isAgentsSkillDir(dir: string): boolean {
  const normalized = resolve(dir)
  const isStandardRoot =
    basename(normalized) === "skills" && basename(dirname(normalized)) === ".agents"
  return isStandardRoot || basename(normalized) === ".agents"
}

/** Resolve the current list of skill directories. */
export function getSkillDirs(cwd?: string): string[] {
  // `cwd` overrides both the spawn cwd and the local cwd — tests pass an explicit
  // dir so they don't need to mutate the process-global CWD via process.chdir,
  // which bleeds across concurrently-running test files (#680).
  const spawnCwd = cwd ?? resolveSpawnCwd()
  const localCwd = cwd ?? process.cwd()
  const dirs = [
    join(spawnCwd, ".skills"),
    ...getProjectAgentsSkillDirs(localCwd),
    ...getProjectAgentsSkillDirs(spawnCwd),
    getAgentsSkillDir(),
    getLegacyAgentsSkillDir(),
    ...getAllProviderSkillDirs(),
  ]
  const local = join(localCwd, ".skills")
  if (!dirs.includes(local)) dirs.unshift(local)
  return uniq(dirs)
}

// Skills live in .skills/ (legacy project-local), repository and user
// .agents/skills/ roots, the legacy ~/.agents/ fallback, and provider globals.
// Each skill is a directory containing SKILL.md.
export const SKILL_DIRS = getSkillDirs()
// Deterministic precedence for duplicate names: first directory wins.
export const SKILL_PRECEDENCE = [...SKILL_DIRS]

// Directory names that should never be treated as skill candidates even when
// they appear directly under a skill root (e.g. stray bun install artefacts).
const NON_SKILL_DIR_NAMES = new Set(["node_modules"])
const AGENTS_ROOT_NON_SKILL_DIR_NAMES = new Set(["skills"])

/** Return true when a directory entry should be scanned as a skill candidate. */
export function isSkillCandidateDir(entry: import("node:fs").Dirent, skillRoot?: string): boolean {
  if (entry.name.startsWith(".")) return false
  if (NON_SKILL_DIR_NAMES.has(entry.name)) return false
  if (
    skillRoot !== undefined &&
    basename(resolve(skillRoot)) === ".agents" &&
    AGENTS_ROOT_NON_SKILL_DIR_NAMES.has(entry.name)
  ) {
    return false
  }
  if (entry.isDirectory()) return true
  if (entry.isSymbolicLink()) {
    if (!skillRoot) return true
    try {
      return statSync(join(skillRoot, entry.name)).isDirectory()
    } catch {
      return false
    }
  }
  return false
}

// ─── Skill existence (sync, cached) ─────────────────────────────────────────

const _skillCache = new Map<string, boolean>()

export interface ResolvedSkillFile {
  name: string
  path: string
}

/** Clear internal skill existence and recency caches. Primarily for testing. */
export function clearSkillCache(): void {
  _skillCache.clear()
  clearSkillRecencyMemoCache()
}

function resolveSkillFilePathFromDirs(name: string, dirs: string[]): string | null {
  if (!name.trim()) return null
  for (const dir of dirs) {
    const skillPath = join(dir, name, "SKILL.md")
    if (existsSync(skillPath)) return skillPath
  }
  return null
}

/** Resolve the first existing SKILL.md using the standard discovery order. */
export function resolveSkillFilePath(name: string, cwd?: string): string | null {
  return resolveSkillFilePathFromDirs(name, getSkillDirs(cwd))
}

/**
 * Resolve an existing SKILL.md for a hook caller. The originating provider's
 * global skill roots take precedence over shared/project roots, so duplicate
 * Claude and Codex skills point at ~/.claude/skills and ~/.codex/skills
 * respectively.
 */
export function resolveSkillFilePathForHookPayload(
  name: string,
  payload: HookPayload,
  cwd?: string
): string | null {
  const agent = detectCurrentAgentFromHookPayload(payload) ?? detectCurrentAgent()
  const providerDirs = agent ? (getProviderAdapter(agent)?.getSkillDirs() ?? []) : []
  return resolveSkillFilePathFromDirs(name, uniq([...providerDirs, ...getSkillDirs(cwd)]))
}

export function skillFileExists(name: string, cwd?: string): boolean {
  return resolveSkillFilePath(name, cwd) !== null
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

  // Use dynamic lookup to support CWD changes in tests
  const found = skillFileExists(name)
  _skillCache.set(name, found)
  return found
}

/**
 * Like skillExists but uses the hook payload to detect the originating agent.
 * For agents with no Skill tool, returns false EXCEPT for Codex, which accesses
 * skills by reading SKILL.md files directly — file existence signals availability.
 *
 * Always uses skillFileExists() for the final existence check rather than skillExists().
 * skillExists() re-detects the agent via process.env, which fails in daemon context:
 * applyDispatchEnv is skipped for inline hooks, so detectCurrentAgent() returns null
 * and skillExists() permanently caches false for the skill name, silently bypassing
 * all skill gates for the daemon process lifetime.
 */
export function skillExistsForHookPayload(
  name: string,
  payload: HookPayload,
  cwd?: string
): boolean {
  const agent = detectCurrentAgentFromHookPayload(payload)
  if (agent?.id === "codex") return skillFileExists(name, cwd)
  if (agent !== null && !agentSupportsTool(agent, "Skill")) return false
  // agent is null (daemon without _env, standalone) or agent supports Skill:
  // the support check is already done above — just test file existence.
  return skillFileExists(name, cwd)
}

export { agentHasTaskToolsForHookPayload }

export function skillGateAgentIdForHookPayload(payload: HookPayload): string {
  return detectCurrentAgentFromHookPayload(payload)?.id ?? detectCurrentAgent()?.id ?? "unknown"
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
  const match = content.match(/^---\n([\s\S]*?)\n---[ \t]*\n?/)
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
const SKILL_TOOL_NAME_RE = /^[A-Za-z][A-Za-z0-9_.-]*$/

function buildCanonicalToolScanSet(): Set<string> {
  const s = new Set<string>()
  for (const a of AGENTS) {
    for (const k of Object.keys(a.toolAliases)) s.add(k)
    for (const v of Object.values(a.toolAliases)) {
      if (SKILL_TOOL_NAME_RE.test(v)) s.add(v)
    }
    for (const toolName of a.additionalToolNames ?? []) s.add(toolName)
    for (const toolName of a.knownToolNames ?? []) s.add(toolName)
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

  for (const m of body.matchAll(/`([A-Za-z][A-Za-z0-9_.-]*)`/g)) {
    const name = m[1]
    if (name && scan.has(name)) found.add(name)
  }

  for (const m of body.matchAll(/\b([A-Za-z][A-Za-z0-9_.-]*)\s*\(/g)) {
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
  referencedTools: string[],
  capabilityInventory: AgentToolCapabilityInventory | null = readAgentToolCapabilityInventoryFromEnv()
): string | null {
  if (agent.id === "claude") return null

  const unsupported = orderBy(
    uniq(referencedTools.filter((t) => !agentSupportsTool(agent, t, capabilityInventory))),
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

function addActiveAgentTools(
  tools: Set<string>,
  active: AgentDef,
  capabilityInventory: AgentToolCapabilityInventory | null
): void {
  // Agent-specific aliases are the primary invocation names.
  const toolAliases = active.toolAliases
  for (const alias of Object.values(toolAliases)) tools.add(alias)
  for (const toolName of active.additionalToolNames ?? []) tools.add(toolName)
  if (capabilityInventory?.agentId === active.id) {
    for (const toolName of capabilityInventory.toolNames) tools.add(toolName)
  }

  // Include canonical names that map for this agent.
  for (const canonical of Object.keys(toolAliases)) {
    if (agentSupportsTool(active, canonical, capabilityInventory)) {
      tools.add(canonical)
    }
  }
}

function addClaudeCanonicalTools(tools: Set<string>, active: AgentDef): void {
  // Claude uses canonical names directly and supports all tools by default.
  if (active.id !== "claude") return
  for (const agent of AGENTS) {
    for (const canonical of Object.keys(agent.toolAliases)) tools.add(canonical)
  }
}

function detectActiveSkillTools(): string[] {
  const active = detectCurrentAgent()
  if (!active) return []
  const capabilityInventory = readAgentToolCapabilityInventoryFromEnv()
  const tools = new Set<string>()

  addActiveAgentTools(tools, active, capabilityInventory)
  addClaudeCanonicalTools(tools, active)

  return orderBy([...tools], [(tool) => tool], ["asc"])
}

interface SkillToolAvailabilityWarning {
  missingTools: string[]
  activeTools: string[]
  requiredTools: string[]
  message: string
}

export function formatSkillReferenceForAgent(skillName: string): string {
  return formatSkillReference(skillName, detectCurrentAgent()?.id)
}

function formatSkillReference(skillName: string, agentId: string | undefined): string {
  switch (agentId) {
    case "claude":
      return `\`/${skillName}\``
    case "codex":
      return `\`$${skillName}\``
  }
  return `Skill(${skillName})`
}

/** Format a skill invocation reference using the hook caller rather than daemon process state. */
export function formatSkillReferenceForHookPayload(
  skillName: string,
  payload: HookPayload
): string {
  const agent = detectCurrentAgentFromHookPayload(payload) ?? detectCurrentAgent()
  return formatSkillReference(skillName, agent?.id)
}

/** Format verified direct-read fallbacks for one or more required skills. */
export function formatSkillFileReadFallback(skillFiles: readonly ResolvedSkillFile[]): string {
  if (skillFiles.length === 0) return ""
  if (skillFiles.length === 1) {
    const skill = skillFiles[0]
    if (!skill) return ""
    return `Verified SKILL.md fallback for /${skill.name} (read directly if native Skill is unavailable): \`${skill.path}\``
  }
  return [
    "Verified SKILL.md fallbacks (read any one directly if native Skill is unavailable):",
    ...skillFiles.map((skill) => `- /${skill.name}: \`${skill.path}\``),
  ].join("\n")
}

export {
  formatCurrentSessionUsageWindow,
  hasAgentDirectlyReadOrInvokedSkill,
  type CurrentSessionUsageRecencyOptions,
}

interface RecencyOptionsMemoEntry {
  result: { recencyOptions: CurrentSessionUsageRecencyOptions; windowText: string }
  timestamp: number
}

interface SkillRecencyMemoEntry {
  active: boolean
  skills: string[]
  fingerprint: string
  timestamp: number
}

const recencyOptionsCache = new Map<string, RecencyOptionsMemoEntry>()
const skillRecencyMemoCache = new Map<string, SkillRecencyMemoEntry>()
const RECENCY_OPTIONS_MEMO_TTL_MS = 5_000
const SKILL_RECENCY_MEMO_TTL_MS = 3_000
const MAX_MEMO_ENTRIES = 50

/** Clear internal skill recency memoization caches. Primarily for testing. */
export function clearSkillRecencyMemoCache(): void {
  recencyOptionsCache.clear()
  skillRecencyMemoCache.clear()
}

/**
 * Resolve the project-configurable skill-recency window (turns + max age) and its
 * human-readable text in one call. Replaces the per-gate `resolveNumericSetting`
 * pair + `formatCurrentSessionUsageWindow` triple duplicated across gate hooks.
 */
export async function resolveSkillRecencyOptions(
  cwd: string
): Promise<{ recencyOptions: CurrentSessionUsageRecencyOptions; windowText: string }> {
  const now = Date.now()
  const cached = recencyOptionsCache.get(cwd)
  if (cached && now - cached.timestamp < RECENCY_OPTIONS_MEMO_TTL_MS) {
    return cached.result
  }

  const [maxTurns, maxAgeMinutes] = await Promise.all([
    resolveNumericSetting(cwd, "skillRecencyMaxTurns", DEFAULT_SKILL_RECENCY_MAX_TURNS),
    resolveNumericSetting(cwd, "skillRecencyMaxAgeMinutes", DEFAULT_SKILL_RECENCY_MAX_AGE_MINUTES),
  ])
  const recencyOptions: CurrentSessionUsageRecencyOptions = {
    maxTurns,
    maxAgeMs: maxAgeMinutes * 60 * 1000,
  }
  const result = { recencyOptions, windowText: formatCurrentSessionUsageWindow(recencyOptions) }

  if (recencyOptionsCache.size >= MAX_MEMO_ENTRIES) {
    for (const [k, entry] of recencyOptionsCache.entries()) {
      if (now - entry.timestamp >= RECENCY_OPTIONS_MEMO_TTL_MS) {
        recencyOptionsCache.delete(k)
      }
    }
    if (recencyOptionsCache.size >= MAX_MEMO_ENTRIES) recencyOptionsCache.clear()
  }
  recencyOptionsCache.set(cwd, { result, timestamp: now })

  return result
}

type CurrentSessionUsageSource = Parameters<typeof getRecentSkillsUsedForCurrentSession>[0]

function firstString(
  values: readonly CurrentSessionUsageSource[keyof CurrentSessionUsageSource][]
): string | null {
  for (const value of values) {
    if (typeof value === "string" && value) return value
  }
  return null
}

function countArrayProperty(
  source: Exclude<CurrentSessionUsageSource, string>,
  property: "_registeredSessionLines"
): number {
  const value = source[property]
  return Array.isArray(value) ? value.length : 0
}

function countUsageEvents(source: Exclude<CurrentSessionUsageSource, string>): number {
  const usage = source._currentSessionToolUsage
  if (!usage || typeof usage !== "object" || !("events" in usage)) return 0
  return Array.isArray(usage.events) ? usage.events.length : 0
}

function computeUsageSourceKey(
  source: CurrentSessionUsageSource,
  cwd: string
): { cacheKey: string; fingerprint: string } | null {
  if (typeof source === "string") {
    return source ? { cacheKey: `${source}:${cwd}`, fingerprint: source } : null
  }
  if (!source || typeof source !== "object") return null

  const keyBase = firstString([
    source.sessionId,
    source.session_id,
    source.sessionPrefix,
    source.transcriptPath,
    source.transcript_path,
  ])
  if (!keyBase) return null

  const usageEventsCount = countUsageEvents(source)
  const sessionLinesCount = countArrayProperty(source, "_registeredSessionLines")
  const toolName = (source.tool_name ?? source.toolName ?? "") as string

  return {
    cacheKey: `${keyBase}:${cwd}`,
    fingerprint: `${keyBase}:${usageEventsCount}:${sessionLinesCount}:${toolName}`,
  }
}

export async function getRecentlyInvokedSkillsForCurrentSession(
  source: CurrentSessionUsageSource,
  options?: CurrentSessionUsageRecencyOptions
): Promise<string[]> {
  return getRecentSkillsUsedForCurrentSession(source, options)
}

export async function getRecentlyUsedToolsForCurrentSession(
  source: CurrentSessionUsageSource,
  options?: CurrentSessionUsageRecencyOptions
): Promise<string[]> {
  return getRecentToolsUsedForCurrentSession(source, options)
}

/**
 * True when a skill is running for this payload's session.
 *
 * Task governance uses this as an escape hatch: a skill drives its own ordered workflow, and a
 * governance gate firing mid-skill blocks a step the skill has already prescribed — leaving the
 * agent with a remedy it cannot reach without abandoning the skill. An active skill is therefore
 * treated as sufficient intent, and the state gates stand down for its duration.
 *
 * Resolves the recency window from settings the same way the active-skills context banner does, so
 * a skill counts as active here for exactly as long as it is reported as active there.
 *
 * Fails closed: any detection error keeps governance enforcing rather than silently disabling it.
 */
export async function hasActiveSkillForHookPayload(
  source: CurrentSessionUsageSource,
  cwd?: string
): Promise<boolean> {
  try {
    const sourceCwd = typeof source === "object" && typeof source.cwd === "string" ? source.cwd : ""
    const resolvedCwd = cwd ?? sourceCwd
    const { recencyOptions } = await resolveSkillRecencyOptions(resolvedCwd)
    const skills = await getRecentSkillsUsedForCurrentSession(source, recencyOptions)
    return skills.length > 0
  } catch {
    return false
  }
}

/**
 * True when any skill was invoked recently in the current session, using the
 * project-configured recency window. Dispatch consults this to relax hook
 * gating while the agent is following skill instructions. Fails closed
 * (returns false) so gating stays intact when recency cannot be determined.
 */
export async function isAnySkillRecentlyActive(
  source: CurrentSessionUsageSource,
  cwd: string
): Promise<boolean> {
  try {
    const keyInfo = computeUsageSourceKey(source, cwd)
    const now = Date.now()

    if (keyInfo) {
      const cached = skillRecencyMemoCache.get(keyInfo.cacheKey)
      if (
        cached &&
        cached.fingerprint === keyInfo.fingerprint &&
        now - cached.timestamp < SKILL_RECENCY_MEMO_TTL_MS
      ) {
        return cached.active
      }
    }

    const { recencyOptions } = await resolveSkillRecencyOptions(cwd)
    const skills = await getRecentlyInvokedSkillsForCurrentSession(source, recencyOptions)
    const active = skills.length > 0

    if (keyInfo) {
      pruneSkillRecencyMemoCache(now)
      skillRecencyMemoCache.set(keyInfo.cacheKey, {
        active,
        skills,
        fingerprint: keyInfo.fingerprint,
        timestamp: now,
      })
    }

    return active
  } catch {
    return false
  }
}

function pruneSkillRecencyMemoCache(now: number): void {
  if (skillRecencyMemoCache.size < MAX_MEMO_ENTRIES) return
  for (const [key, entry] of skillRecencyMemoCache.entries()) {
    if (now - entry.timestamp >= SKILL_RECENCY_MEMO_TTL_MS) {
      skillRecencyMemoCache.delete(key)
    }
  }
  if (skillRecencyMemoCache.size >= MAX_MEMO_ENTRIES) skillRecencyMemoCache.clear()
}

export async function wasSkillRecentlyInvokedInCurrentSession(
  source: CurrentSessionUsageSource,
  skillName: string,
  options?: CurrentSessionUsageRecencyOptions
): Promise<boolean> {
  return (await getRecentlyInvokedSkillsForCurrentSession(source, options)).includes(skillName)
}

/**
 * Skills whose recent use opens an escape hatch through edit-blocking gates.
 * `/unblock-myself` and `/re-assess` are the designated "I've deliberately
 * stepped back and reconsidered" actions — exactly what a contested block asks
 * for — so recent use of either should let an otherwise-blocked edit proceed.
 */
const EDIT_UNBLOCK_SKILLS = ["unblock-myself", "re-assess"] as const

/**
 * True when `/unblock-myself` or `/re-assess` was invoked recently in the current
 * session. Edit-blocking PreToolUse gates consult this to stand down after the
 * agent has taken the deliberate re-assess/unblock action rather than blindly
 * retrying the same call.
 */
export async function wasEditUnblockSkillRecentlyUsed(
  source: CurrentSessionUsageSource,
  options?: CurrentSessionUsageRecencyOptions
): Promise<boolean> {
  const invoked = await getRecentlyInvokedSkillsForCurrentSession(source, options)
  return EDIT_UNBLOCK_SKILLS.some((skill) => invoked.includes(skill))
}

/**
 * Check whether a skill was invoked anywhere in the given session lines.
 * Unlike `getRecentlyInvokedSkillsForCurrentSession`, this scans ALL lines
 * (not filtered to the current user turn) to avoid timing race conditions
 * where the Skill tool call was just appended to the transcript.
 */
export function hasSkillInSessionLines(lines: string[], skillName: string): boolean {
  return computeSummaryFromSessionLines(lines).skillInvocations.includes(skillName)
}

/**
 * Check whether a skill was invoked in ANY session for the current project
 * within the last `maxAgeMs` milliseconds (default 5 minutes).
 * Scans all recently-modified JSONL transcript files under
 * `~/.claude/projects/<projectKey>/`.
 */
export async function hasSkillUsedInProjectRecently(
  skillName: string,
  cwd: string,
  home?: string,
  maxAgeMs = 5 * 60 * 1000
): Promise<boolean> {
  const resolvedHome = home ?? process.env.HOME ?? ""
  if (!resolvedHome) return false
  const projectKey = projectKeyFromCwd(cwd)
  const projectDir = join(resolvedHome, ".claude", "projects", projectKey)
  const now = Date.now()
  let files: string[]
  try {
    files = await readdir(projectDir)
  } catch {
    return false
  }
  for (const f of files) {
    if (!f.endsWith(".jsonl")) continue
    const filePath = join(projectDir, f)
    if (await recentTranscriptContainsSkill(filePath, skillName, now, maxAgeMs)) return true
  }
  return false
}

async function recentTranscriptContainsSkill(
  filePath: string,
  skillName: string,
  now: number,
  maxAgeMs: number
): Promise<boolean> {
  try {
    const { mtimeMs } = await stat(filePath)
    if (now - mtimeMs > maxAgeMs) return false
    const text = await Bun.file(filePath).text()
    return hasSkillInSessionLines(text.split("\n"), skillName)
  } catch {
    return false
  }
}

export async function wasToolRecentlyUsedInCurrentSession(
  source: CurrentSessionUsageSource,
  toolName: string,
  options?: CurrentSessionUsageRecencyOptions
): Promise<boolean> {
  return (await getRecentlyUsedToolsForCurrentSession(source, options)).includes(toolName)
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
    message: `⚠ Skill tool availability warning for ${formatSkillReferenceForAgent(skillName)}: required tool(s) not active in this session: ${missingTools.join(", ")}. Active tool list: ${available.join(", ")}.`,
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
    // Strip Markdown formatting for word counting
    const plain = subject.replace(/`[^`]*`/g, "").trim()
    const wordCount = plain.split(/\s+/).filter(Boolean).length
    if (wordCount < 2) return false
    return !BACKTICK_DOMINANT_RE.test(subject)
  })
}

// ─── Skill listing (async) ───────────────────────────────────────────────────

interface SkillInfo {
  name: string
  description: string
  source: "local" | "global"
  path: string
}

export interface SkillConflictEntry {
  dir: string
  path: string
  shared: boolean
}

export interface SkillConflict {
  name: string
  active: SkillConflictEntry
  overridden: SkillConflictEntry[]
}

export async function findSkills(): Promise<SkillInfo[]> {
  const skills: SkillInfo[] = []
  const seen = new Set<string>()
  const skillDirs = getSkillDirs()

  for (const dir of skillDirs) {
    let entries: import("node:fs").Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }

    const directoryNames = entries
      .filter((entry) => isSkillCandidateDir(entry, dir))
      .map((entry) => entry.name)
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
        source: dir === skillDirs[0] ? "local" : "global",
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
  const directoryNames = entries
    .filter((entry) => isSkillCandidateDir(entry, dir))
    .map((entry) => entry.name)
  for (const name of orderBy(directoryNames, [(n) => n], ["asc"])) {
    const skillPath = join(dir, name, "SKILL.md")
    if (!(await Bun.file(skillPath).exists())) continue
    const existing = byName.get(name) ?? []
    existing.push({ dir, path: skillPath, shared: isAgentsSkillDir(dir) })
    byName.set(name, existing)
  }
}

export async function findSkillConflicts(
  skillDirs: string[] = getSkillDirs()
): Promise<SkillConflict[]> {
  const byName = new Map<string, SkillConflictEntry[]>()
  for (const dir of skillDirs) await scanSkillDir(dir, byName)

  const conflicts: SkillConflict[] = []

  for (const name of orderBy([...byName.keys()], [(n) => n], ["asc"])) {
    const entries = byName.get(name) ?? []
    if (entries.length <= 1) continue
    const [active, ...overridden] = entries
    if (active) conflicts.push({ name, active, overridden })
  }
  return conflicts
}
