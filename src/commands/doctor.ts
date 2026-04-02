import type { Dirent, Stats } from "node:fs"
import { chmod, cp, mkdir, readdir, readFile, stat } from "node:fs/promises"
import { dirname, join } from "node:path"
import { getAgentSettingsSearchPaths } from "../agent-paths.ts"
import { AGENTS, type AgentDef, CONFIGURABLE_AGENTS, getAgent, translateEvent } from "../agents.ts"
import { suggest } from "../fuzzy.ts"
import { getHomeDir, getHomeDirWithFallback } from "../home.ts"
import {
  getLaunchAgentPlistPath,
  isLaunchAgentLoaded,
  launchAgentExists,
  loadLaunchAgent,
  SWIZ_DAEMON_LABEL,
  unloadLaunchAgent,
} from "../launch-agents.ts"
import { isInlineHookDef, manifest } from "../manifest.ts"
import { projectKeyFromCwd } from "../project-key.ts"
import { listProviderAdapters } from "../provider-adapters.ts"
import { defaultTrashPath } from "../session-data-delete.ts"
import { readProjectSettings, readSwizSettings } from "../settings.ts"
import {
  findSkillConflicts,
  parseFrontmatterField,
  SKILL_PRECEDENCE,
  type SkillConflict,
  type SkillConflictEntry,
} from "../skill-utils.ts"
import { createDefaultTaskStore } from "../task-roots.ts"
import type { Command } from "../types.ts"
import { readLines } from "../utils/file-utils.ts"
import { formatBytes } from "../utils/format.ts"
import { stripQuotes } from "../utils/quoted-string.ts"
import { convertSkillContent } from "../utils/skill-conversion.ts"
import { DIAGNOSTIC_CHECKS } from "./doctor/checks"
import type { CheckResult } from "./doctor/types.ts"
import { whichExists } from "./doctor/utils.ts"

/**
 * Built-in allowed values for the `category:` frontmatter field in SKILL.md files.
 * Projects can override this list via `allowedSkillCategories` in `.swiz/config.json`.
 */
export const DEFAULT_ALLOWED_SKILL_CATEGORIES: readonly string[] = [
  "automation",
  "code-review",
  "communication",
  "data",
  "deployment",
  "design",
  "development",
  "git",
  "learning",
  "productivity",
  "research",
  "security",
  "testing",
  "uncategorized",
  "workflow",
  "writing",
]

const SWIZ_ROOT = dirname(Bun.main)
const HOOKS_DIR = join(SWIZ_ROOT, "hooks")
const DAEMON_PORT = Number(process.env.SWIZ_DAEMON_PORT) || 7943

import { BOLD, DIM, GREEN, RED, RESET, YELLOW } from "../ansi.ts"

const HOME = getHomeDirWithFallback("")

const PASS = `${GREEN}✓${RESET}`
const FAIL = `${RED}✗${RESET}`
const WARN = `${YELLOW}!${RESET}`

// ─── Individual checks ──────────────────────────────────────────────────────

async function checkAgentBinary(agent: AgentDef): Promise<CheckResult> {
  const path = await whichExists(agent.binary)

  return {
    name: `${agent.name} binary`,
    status: path ? "pass" : "warn",
    detail: path ?? `"${agent.binary}" not found on PATH`,
  }
}

async function checkAgentSettings(agent: AgentDef): Promise<CheckResult> {
  const file = Bun.file(agent.settingsPath)
  const exists = await file.exists()

  if (!exists) {
    return {
      name: `${agent.name} settings`,
      status: "warn",
      detail: `${agent.settingsPath} not found`,
    }
  }

  // Non-JSON config formats (e.g. TOML): verify readable and non-empty
  if (!agent.settingsPath.endsWith(".json")) {
    try {
      const content = await file.text()
      if (!content.trim()) {
        return {
          name: `${agent.name} settings`,
          status: "warn",
          detail: `${agent.settingsPath} is empty`,
        }
      }
      return {
        name: `${agent.name} settings`,
        status: "pass",
        detail: agent.settingsPath,
      }
    } catch {
      return {
        name: `${agent.name} settings`,
        status: "fail",
        detail: `${agent.settingsPath} exists but is not readable`,
      }
    }
  }

  try {
    await file.json()
    return {
      name: `${agent.name} settings`,
      status: "pass",
      detail: agent.settingsPath,
    }
  } catch {
    return {
      name: `${agent.name} settings`,
      status: "fail",
      detail: `${agent.settingsPath} exists but is malformed JSON`,
    }
  }
}

async function checkHookScripts(): Promise<CheckResult> {
  const allFiles = new Set<string>()
  for (const group of manifest) {
    for (const hook of group.hooks) {
      if (isInlineHookDef(hook)) continue
      allFiles.add(hook.file)
    }
  }

  const missing: string[] = []
  for (const file of allFiles) {
    const path = join(HOOKS_DIR, file)
    if (!(await Bun.file(path).exists())) {
      missing.push(file)
    }
  }

  if (missing.length === 0) {
    return {
      name: "Hook scripts",
      status: "pass",
      detail: `all ${allFiles.size} manifest scripts found in hooks/`,
    }
  }

  return {
    name: "Hook scripts",
    status: "fail",
    detail: `${missing.length} missing: ${missing.join(", ")}`,
  }
}

/** Validate that every handler path referenced in the manifest resolves to an existing file. */
async function checkManifestHandlerPaths(): Promise<CheckResult> {
  const hookFiles = [
    ...new Set(
      manifest.flatMap((g) => g.hooks.flatMap((h) => (isInlineHookDef(h) ? [] : [h.file])))
    ),
  ]

  if (hookFiles.length === 0) {
    return {
      name: "Manifest handler paths",
      status: "pass",
      detail: `no handler files in manifest (hooks root: ${HOOKS_DIR})`,
    }
  }

  const missing: string[] = []
  for (const file of hookFiles) {
    const abs = join(HOOKS_DIR, file)
    if (!(await Bun.file(abs).exists())) {
      missing.push(file)
    }
  }

  if (missing.length === 0) {
    return {
      name: "Manifest handler paths",
      status: "pass",
      detail: `all ${hookFiles.length} handler paths valid (hooks root: ${HOOKS_DIR})`,
    }
  }

  return {
    name: "Manifest handler paths",
    status: "fail",
    detail: `${missing.length} missing handler paths: ${missing.join(", ")}`,
  }
}

/** Return basenames of .ts entry points in hooks/ not referenced by the manifest or any agent config. */
async function findOrphanedHookScripts(): Promise<string[]> {
  const manifestFiles = new Set(
    manifest.flatMap((g) => g.hooks.flatMap((h) => (isInlineHookDef(h) ? [] : [h.file])))
  )

  // Extract inline hook filenames from manifest.ts import statements.
  // Inline hooks are imported as: import hookName from "../hooks/hook-name.ts"
  try {
    const manifestPath = join(dirname(import.meta.filename), "../manifest.ts")
    const manifestSource = await Bun.file(manifestPath).text()
    const inlineHookImports =
      manifestSource.match(/^import\s+\w+\s+from\s+['"]\.\.\/hooks\/([\w-]+)\.ts['"]/gm) ?? []
    for (const importStmt of inlineHookImports) {
      const match = importStmt.match(/from\s+['"]\.\.\/hooks\/([\w-]+)\.ts['"]/)
      if (match?.[1]) {
        manifestFiles.add(`${match[1]}.ts`)
      }
    }
  } catch {
    // Ignore errors reading manifest — orphaned check is optional
  }

  // Scripts referenced by agent configs that live inside hooks/ (by basename)
  const configPaths = await collectInstalledConfigScriptPaths()
  const configBasenames = new Set(
    configPaths
      .filter((p) => p.startsWith(`${HOOKS_DIR}/`))
      .map((p) => p.slice(HOOKS_DIR.length + 1))
  )

  const glob = new Bun.Glob("*.ts")
  const orphaned: string[] = []
  for await (const file of glob.scan({ cwd: HOOKS_DIR })) {
    if (file.endsWith(".test.ts")) continue
    if (manifestFiles.has(file)) continue
    if (configBasenames.has(file)) continue
    // Only flag hook entry points — library files lack a bun shebang
    const chunk = await Bun.file(join(HOOKS_DIR, file)).slice(0, 256).text()
    const firstLine = chunk.split("\n", 1)[0] ?? ""
    if (!firstLine.startsWith("#!/") || !firstLine.includes("bun")) continue
    orphaned.push(file)
  }
  orphaned.sort()
  return orphaned
}

function buildOrphanedResult(orphaned: string[]): CheckResult {
  if (orphaned.length === 0) {
    return {
      name: "Orphaned hook scripts",
      status: "pass",
      detail: `no orphaned scripts found in hooks/`,
    }
  }
  return {
    name: "Orphaned hook scripts",
    status: "warn",
    detail: `${orphaned.length} script(s) in hooks/ not referenced by manifest or config: ${orphaned.join(", ")} — run: swiz doctor --fix`,
  }
}

/** Orphaned hook scripts are reported by the check but no longer auto-disabled. */

/** Return config-referenced script paths that do not exist on disk. */
async function findMissingConfigScriptPaths(): Promise<string[]> {
  const configPaths = await collectInstalledConfigScriptPaths()
  const missing: string[] = []
  for (const p of configPaths) {
    if (!(await Bun.file(p).exists())) missing.push(p)
  }
  return missing
}

interface MissingScriptFixSuccess {
  path: string
}
interface MissingScriptFixFailure {
  path: string
  error: string
}

/** Create minimal executable stub scripts for config-referenced paths that are missing. */
async function fixMissingConfigScripts(paths: string[]): Promise<{
  registered: MissingScriptFixSuccess[]
  failed: MissingScriptFixFailure[]
}> {
  const registered: MissingScriptFixSuccess[] = []
  const failed: MissingScriptFixFailure[] = []
  const stub =
    "#!/usr/bin/env bun\n// Registered by swiz doctor --fix. Implement this hook script.\n"
  for (const p of paths) {
    try {
      await mkdir(dirname(p), { recursive: true })
      await Bun.write(p, stub)
      await chmod(p, 0o755)
      registered.push({ path: p })
    } catch (err: unknown) {
      failed.push({ path: p, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return { registered, failed }
}

// checkGhAuth and checkTtsBackend extracted to doctor/checks/

async function checkSwizSettings(): Promise<CheckResult> {
  try {
    const settings = await readSwizSettings({ strict: true })
    const keys = Object.keys(settings).filter((k) => k !== "sessions")
    return {
      name: "Swiz settings",
      status: "pass",
      detail: keys
        .map((k) => `${k}=${JSON.stringify(settings[k as keyof typeof settings])}`)
        .join(", "),
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return {
      name: "Swiz settings",
      status: "fail",
      detail: msg,
    }
  }
}

function displayPath(path: string): string {
  return HOME && path.startsWith(HOME) ? `~${path.slice(HOME.length)}` : path
}

function formatSkillPrecedence(): string {
  return SKILL_PRECEDENCE.map((dir) => displayPath(dir)).join(" > ")
}

function buildSkillConflictResults(conflicts: SkillConflict[]): CheckResult[] {
  if (conflicts.length === 0) {
    return [
      {
        name: "Skill conflicts",
        status: "pass",
        detail: `no duplicate skill names across ${SKILL_PRECEDENCE.length} skill directories`,
      },
    ]
  }

  const precedence = formatSkillPrecedence()
  return conflicts.map((conflict) => ({
    name: `Skill conflict: ${conflict.name}`,
    status: "warn",
    detail:
      `active=${displayPath(conflict.active.path)}; overridden=` +
      `${conflict.overridden.map((entry) => displayPath(entry.path)).join(", ")}; ` +
      `precedence=${precedence} — run: swiz doctor --fix`,
  }))
}

/** Skill conflicts are reported by the check but no longer auto-disabled. */

// ─── Invalid skill entries check ────────────────────────────────────────────

interface InvalidSkillEntry {
  name: string
  skillDir: string
  entryDir: string
  reason: string
}

/** Required frontmatter fields that every SKILL.md must declare. */
const REQUIRED_SKILL_FIELDS = ["name", "description"] as const

/**
 * Scan all skill dirs for subdirectories with missing or invalid SKILL.md.
 * Validates: file existence, non-empty content, frontmatter block, required
 * frontmatter fields (name, description), and category against allowedCategories.
 */
function validateSkillFrontmatter(
  content: string,
  dirName: string,
  base: { name: string; skillDir: string; entryDir: string }
): InvalidSkillEntry[] {
  const issues: InvalidSkillEntry[] = []
  const missing = REQUIRED_SKILL_FIELDS.filter((f) => !parseFrontmatterField(content, f))
  if (missing.length > 0) {
    issues.push({ ...base, reason: `missing required frontmatter field(s): ${missing.join(", ")}` })
  }
  const rawName = parseFrontmatterField(content, "name") ?? ""
  if (rawName) {
    const unquotedName = rawName.replace(/^["']|["']$/g, "")
    if (unquotedName !== dirName) {
      issues.push({
        ...base,
        reason: `frontmatter name "${unquotedName}" does not match directory name "${dirName}"`,
      })
    }
  }
  const description = parseFrontmatterField(content, "description")
  if (description?.trim() === SKILL_PLACEHOLDER_DESCRIPTION) {
    issues.push({
      ...base,
      reason: `description is the generated placeholder — update SKILL.md with a real description`,
    })
  }
  return issues
}

function validateSkillContent(
  content: string,
  dirName: string,
  skillDir: string,
  entryDir: string,
  allowedCategories: ReadonlySet<string>
): InvalidSkillEntry[] {
  const base = { name: dirName, skillDir, entryDir }
  const frontmatterIssues = validateSkillFrontmatter(content, dirName, base)
  if (frontmatterIssues.length > 0) return frontmatterIssues

  const issues: InvalidSkillEntry[] = []
  const rawCategory = parseFrontmatterField(content, "category")
  if (!rawCategory) {
    issues.push({ ...base, reason: MISSING_CATEGORY_REASON })
    return issues
  }
  const cat = rawCategory.trim()
  if (!allowedCategories.has(cat)) {
    const suggestion = suggest(cat, allowedCategories)
    const hint = suggestion ? ` (did you mean: "${suggestion}"?)` : ""
    issues.push({
      ...base,
      reason: `${INVALID_CATEGORY_REASON_PREFIX}${cat}"${hint} — allowed: ${[...allowedCategories].sort().join(", ")}`,
    })
  }
  return issues
}

async function validateSkillEntry(
  entry: import("node:fs").Dirent,
  skillDir: string,
  allowedCategories: ReadonlySet<string>
): Promise<InvalidSkillEntry[]> {
  if (!entry.isDirectory()) return []
  if (entry.name.startsWith(".")) return []
  const entryDir = join(skillDir, entry.name)
  const skillPath = join(entryDir, "SKILL.md")
  const base = { name: entry.name, skillDir, entryDir }
  const file = Bun.file(skillPath)
  if (!(await file.exists())) return [{ ...base, reason: "missing SKILL.md" }]
  const content = await file.text()
  if (!content.trim()) return [{ ...base, reason: "empty SKILL.md" }]
  if (!/^---/m.test(content)) {
    return [{ ...base, reason: "SKILL.md has no frontmatter block (expected --- delimiters)" }]
  }
  return validateSkillContent(content, entry.name, skillDir, entryDir, allowedCategories)
}

async function findInvalidSkillEntries(
  allowedCategories: ReadonlySet<string>
): Promise<InvalidSkillEntry[]> {
  const invalid: InvalidSkillEntry[] = []
  for (const skillDir of SKILL_PRECEDENCE) {
    let entries: import("node:fs").Dirent[]
    try {
      entries = await readdir(skillDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      invalid.push(...(await validateSkillEntry(entry, skillDir, allowedCategories)))
    }
  }
  invalid.sort((a, b) => a.name.localeCompare(b.name))
  return invalid
}

function buildInvalidSkillResults(entries: InvalidSkillEntry[]): CheckResult[] {
  if (entries.length === 0) {
    return [
      {
        name: "Invalid skill entries",
        status: "pass",
        detail: `no invalid skill entries found across ${SKILL_PRECEDENCE.length} skill directories`,
      },
    ]
  }
  return entries.map((entry) => ({
    name: `Invalid skill: ${entry.name}`,
    status: "warn" as const,
    detail: `${displayPath(entry.entryDir)}: ${entry.reason} — run: swiz doctor --fix`,
  }))
}

interface InvalidSkillNameFixSuccess {
  name: string
  skillPath: string
  oldName: string
}
interface InvalidSkillGenerateSuccess {
  name: string
  skillPath: string
}
interface InvalidSkillCategoryFixSuccess {
  name: string
  skillPath: string
}
interface InvalidSkillFixFailure {
  name: string
  originalDir: string
  error: string
}

const NAME_MISMATCH_PREFIX = 'frontmatter name "'
const MISSING_SKILL_MD_REASON = "missing SKILL.md"
const MISSING_CATEGORY_REASON = "missing category field"
const INVALID_CATEGORY_REASON_PREFIX = 'unknown category "'
/** Default description injected by swiz doctor --fix into generated SKILL.md stubs. */
const SKILL_PLACEHOLDER_DESCRIPTION = "Add a description for this skill."
/** Default category used by swiz doctor --fix when no category field is present or it is invalid. */
const SKILL_PLACEHOLDER_CATEGORY = "uncategorized"

/** For name-mismatch entries: update the name: field in SKILL.md to match the directory name. */
async function fixSkillNameMismatch(entry: InvalidSkillEntry): Promise<{ oldName: string } | null> {
  const skillPath = join(entry.entryDir, "SKILL.md")
  try {
    const content = await Bun.file(skillPath).text()
    // Extract the current quoted/unquoted name value so we can report what changed
    const rawName = parseFrontmatterField(content, "name") ?? ""
    const oldName = stripQuotes(rawName)
    // Replace the name: line value (handles both quoted and unquoted values)
    const updated = content.replace(/^(name:\s*)["']?[^"'\n]+["']?/m, `$1${entry.name}`)
    await Bun.write(skillPath, updated)
    return { oldName }
  } catch {
    return null
  }
}

/** For missing-SKILL.md entries: generate a default stub so the directory is a valid skill. */
async function generateSkillMd(entry: InvalidSkillEntry): Promise<boolean> {
  const skillPath = join(entry.entryDir, "SKILL.md")
  try {
    const stub = `---\nname: ${entry.name}\ndescription: ${SKILL_PLACEHOLDER_DESCRIPTION}\ncategory: ${SKILL_PLACEHOLDER_CATEGORY}\n---\n`
    await Bun.write(skillPath, stub)
    return true
  } catch {
    return false
  }
}

/** For missing-category entries: insert a default category field after the description line. */
async function fixMissingCategory(entry: InvalidSkillEntry): Promise<boolean> {
  const skillPath = join(entry.entryDir, "SKILL.md")
  try {
    const content = await Bun.file(skillPath).text()
    const updated = content.replace(
      /^(description:\s*.+)$/m,
      `$1\ncategory: ${SKILL_PLACEHOLDER_CATEGORY}`
    )
    if (updated === content) return false
    await Bun.write(skillPath, updated)
    return true
  } catch {
    return false
  }
}

/** For invalid-category entries: replace the existing category value with the default. */
async function fixCategoryValue(entry: InvalidSkillEntry): Promise<boolean> {
  const skillPath = join(entry.entryDir, "SKILL.md")
  try {
    const content = await Bun.file(skillPath).text()
    const updated = content.replace(
      /^(category:\s*)["']?[^"'\n]+["']?/m,
      `$1${SKILL_PLACEHOLDER_CATEGORY}`
    )
    if (updated === content) return false
    await Bun.write(skillPath, updated)
    return true
  } catch {
    return false
  }
}

/** Repair invalid skill entries in-place.
 *  - missing SKILL.md    → generate a default stub
 *  - name mismatch       → update name: field in place
 *  - missing category    → insert category: uncategorized after description line
 *  - everything else     → reported as unfixable */
async function fixInvalidSkillEntries(entries: InvalidSkillEntry[]): Promise<{
  nameFixed: InvalidSkillNameFixSuccess[]
  generated: InvalidSkillGenerateSuccess[]
  categoryFixed: InvalidSkillCategoryFixSuccess[]
  failed: InvalidSkillFixFailure[]
}> {
  const nameFixed: InvalidSkillNameFixSuccess[] = []
  const generated: InvalidSkillGenerateSuccess[] = []
  const categoryFixed: InvalidSkillCategoryFixSuccess[] = []
  const failed: InvalidSkillFixFailure[] = []
  for (const entry of entries) {
    if (entry.reason === MISSING_SKILL_MD_REASON) {
      const skillPath = join(entry.entryDir, "SKILL.md")
      if (await generateSkillMd(entry)) {
        generated.push({ name: entry.name, skillPath })
      } else {
        failed.push({
          name: entry.name,
          originalDir: entry.entryDir,
          error: "could not create SKILL.md",
        })
      }
      continue
    }
    if (entry.reason.startsWith(NAME_MISMATCH_PREFIX)) {
      const result = await fixSkillNameMismatch(entry)
      if (result !== null) {
        nameFixed.push({
          name: entry.name,
          skillPath: join(entry.entryDir, "SKILL.md"),
          oldName: result.oldName,
        })
      } else {
        failed.push({
          name: entry.name,
          originalDir: entry.entryDir,
          error: "could not update SKILL.md name field",
        })
      }
      continue
    }
    if (entry.reason === MISSING_CATEGORY_REASON) {
      const skillPath = join(entry.entryDir, "SKILL.md")
      if (await fixMissingCategory(entry)) {
        categoryFixed.push({ name: entry.name, skillPath })
      } else {
        failed.push({
          name: entry.name,
          originalDir: entry.entryDir,
          error: "could not insert category field into SKILL.md",
        })
      }
      continue
    }
    if (entry.reason.startsWith(INVALID_CATEGORY_REASON_PREFIX)) {
      const skillPath = join(entry.entryDir, "SKILL.md")
      if (await fixCategoryValue(entry)) {
        categoryFixed.push({ name: entry.name, skillPath })
      } else {
        failed.push({
          name: entry.name,
          originalDir: entry.entryDir,
          error: "could not update category field in SKILL.md",
        })
      }
      continue
    }
    failed.push({
      name: entry.name,
      originalDir: entry.entryDir,
      error: entry.reason,
    })
  }
  return { nameFixed, generated, categoryFixed, failed }
}

// ─── Installed config script check ──────────────────────────────────────────

/** Config keys whose values are shell-executable strings (or arrays of args/commands). */
const SHELL_STRING_KEYS = new Set(["command", "scripts", "run", "args"])

/**
 * Recursively walk any JSON value and collect every shell-executable string at any depth.
 * Collects string values (and strings within arrays) for the keys: command, scripts, run, args.
 */
function collectCommandStrings(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(collectCommandStrings)
  }
  if (value !== null && typeof value === "object") {
    const results: string[] = []
    for (const [k, v] of Object.entries(value as Record<string, any>)) {
      if (SHELL_STRING_KEYS.has(k)) {
        if (typeof v === "string") {
          results.push(v)
        } else if (Array.isArray(v)) {
          results.push(...v.filter((item): item is string => typeof item === "string"))
        }
      } else {
        results.push(...collectCommandStrings(v))
      }
    }
    return results
  }
  return []
}

/** Collect all command strings from a hooks config object at any nesting depth. */
function collectHookCommands(hooks: Record<string, any>): string[] {
  return collectCommandStrings(hooks)
}

/** Extract absolute paths to script files referenced in a shell command string. */
function extractScriptPaths(command: string): string[] {
  const scriptExtRe = /\.(ts|js|sh|bash|mjs|cjs|py)$/
  const seen = new Set<string>()
  const paths: string[] = []

  function addRaw(raw: string): void {
    raw = raw.trim()
    if (!raw || !scriptExtRe.test(raw)) return
    const expanded = raw.startsWith("~/")
      ? join(HOME, raw.slice(2))
      : raw.startsWith("$HOME/")
        ? join(HOME, raw.slice(6))
        : raw
    if (!seen.has(expanded)) {
      seen.add(expanded)
      paths.push(expanded)
    }
  }

  // 1. Double-quoted paths (may contain spaces): bun "/path with spaces/hook.ts"
  for (const m of command.matchAll(/"((?:\/|~\/|\$HOME\/)[^"]+)"/g)) {
    addRaw(m[1] ?? "")
  }
  // 2. Single-quoted paths (may contain spaces): bun '/path with spaces/hook.ts'
  for (const m of command.matchAll(/'((?:\/|~\/|\$HOME\/)[^']+)'/g)) {
    addRaw(m[1] ?? "")
  }
  // 3. Unquoted tokens delimited by whitespace/special chars
  for (const m of command.matchAll(/(?:^|\s)(\/[^\s'";&|]+|~\/[^\s'";&|]+|\$HOME\/[^\s'";&|]+)/g)) {
    addRaw(m[1] ?? "")
  }

  return paths
}

async function extractPathsFromSettingsFile(
  settingsPath: string,
  agent: (typeof CONFIGURABLE_AGENTS)[number]
): Promise<string[]> {
  const file = Bun.file(settingsPath)
  if (!(await file.exists())) return []
  let settings: Record<string, any>
  try {
    settings = await file.json()
  } catch {
    return []
  }
  const hooksRaw = agent.wrapsHooks
    ? ((settings.hooks as Record<string, any>) ?? {})
    : ((settings[agent.hooksKey] as Record<string, any>) ?? {})
  const hooks = typeof hooksRaw === "object" && !Array.isArray(hooksRaw) ? hooksRaw : {}
  return [...collectHookCommands(hooks)].flatMap((cmd) => extractScriptPaths(cmd))
}

/** Collect deduplicated script file paths referenced in installed agent hook configs. */
async function collectInstalledConfigScriptPaths(): Promise<string[]> {
  const paths: string[] = []
  for (const agent of CONFIGURABLE_AGENTS) {
    const agentId = agent.id as "claude" | "cursor" | "gemini" | "codex" | "junie"
    for (const settingsPath of getAgentSettingsSearchPaths(agentId)) {
      paths.push(...(await extractPathsFromSettingsFile(settingsPath, agent)))
    }
  }
  return [...new Set(paths)]
}

/** Verify that all executable script paths (manifest + config) exist and are executable. */
async function buildScriptPathSourceMap(): Promise<Map<string, "manifest" | "config">> {
  const pathSource = new Map<string, "manifest" | "config">()
  for (const group of manifest) {
    for (const hook of group.hooks) {
      if (isInlineHookDef(hook)) continue
      pathSource.set(join(HOOKS_DIR, hook.file), "manifest")
    }
  }
  for (const p of await collectInstalledConfigScriptPaths()) {
    if (!pathSource.has(p)) pathSource.set(p, "config")
  }
  return pathSource
}

async function checkInstalledConfigScripts(): Promise<CheckResult> {
  const pathSource = await buildScriptPathSourceMap()
  const missing: string[] = []
  const notExecutable: string[] = []

  for (const [scriptPath, source] of pathSource) {
    const label = `${scriptPath} (${source})`
    if (!(await Bun.file(scriptPath).exists())) {
      missing.push(label)
      continue
    }
    try {
      const s = await stat(scriptPath)
      if ((s.mode & 0o100) === 0) notExecutable.push(label)
    } catch {
      missing.push(label)
    }
  }

  if (missing.length === 0 && notExecutable.length === 0) {
    return {
      name: "Installed config scripts",
      status: "pass",
      detail: `all ${pathSource.size} executable scripts are present and executable`,
    }
  }

  const details: string[] = []
  if (missing.length > 0) {
    details.push(`${missing.length} missing: ${missing.join(", ")}`)
  }
  if (notExecutable.length > 0) {
    details.push(`${notExecutable.length} not executable: ${notExecutable.join(", ")}`)
  }
  return {
    name: "Installed config scripts",
    status: "fail",
    detail: details.join("; "),
  }
}

// ─── Script execute permission check ────────────────────────────────────────

/** Collect all script file paths that should have execute permission. */
async function collectExecutableScriptPaths(): Promise<string[]> {
  const paths: string[] = []
  // All manifest hook scripts
  for (const group of manifest) {
    for (const hook of group.hooks) {
      if (isInlineHookDef(hook)) continue
      paths.push(join(HOOKS_DIR, hook.file))
    }
  }
  // Script paths referenced in installed agent configs (via shared helper)
  paths.push(...(await collectInstalledConfigScriptPaths()))
  return [...new Set(paths)]
}

function buildPermissionsResult(opts: {
  fix: boolean
  paths: string[]
  notExecutable: string[]
  fixed: string[]
  fixFailed: string[]
}): CheckResult {
  const { fix, paths, notExecutable, fixed, fixFailed } = opts
  if (fix) {
    if (fixed.length === 0 && fixFailed.length === 0) {
      return {
        name: "Script execute permissions",
        status: "pass",
        detail: "all scripts already executable",
      }
    }
    if (fixFailed.length > 0) {
      return {
        name: "Script execute permissions",
        status: "fail",
        detail: `chmod failed for ${fixFailed.length} script(s): ${fixFailed.join(", ")}`,
      }
    }
    return {
      name: "Script execute permissions",
      status: "pass",
      detail: `fixed execute permissions on ${fixed.length} script(s)`,
    }
  }
  if (notExecutable.length === 0) {
    return {
      name: "Script execute permissions",
      status: "pass",
      detail: `all ${paths.length} scripts are executable`,
    }
  }
  return {
    name: "Script execute permissions",
    status: "warn",
    detail: `${notExecutable.length} script(s) missing execute permission — run: swiz doctor --fix`,
  }
}

/** Check (and optionally fix) execute permissions on all referenced hook scripts. */
async function checkScriptExecutePermissions(fix: boolean): Promise<CheckResult> {
  const paths = await collectExecutableScriptPaths()
  const notExecutable: string[] = []
  const fixed: string[] = []
  const fixFailed: string[] = []

  for (const p of paths) {
    let s: { mode: number }
    try {
      s = await stat(p)
    } catch {
      continue // missing files reported separately by existence checks
    }
    if ((s.mode & 0o100) !== 0) continue // owner execute bit set
    if (fix) {
      try {
        await chmod(p, s.mode | 0o111)
        fixed.push(p)
      } catch {
        fixFailed.push(p)
      }
    } else {
      notExecutable.push(p)
    }
  }

  return buildPermissionsResult({ fix, paths, notExecutable, fixed, fixFailed })
}

// ─── Config sync check ──────────────────────────────────────────────────────

/** Extract canonical event names from `swiz dispatch <event> ...` commands in a config. */
function extractDispatchEvents(hooks: Record<string, any>): Set<string> {
  const events = new Set<string>()
  const dispatchRe = /swiz dispatch (\S+)/
  for (const cmd of collectCommandStrings(hooks)) {
    const m = dispatchRe.exec(cmd)
    if (m?.[1]) events.add(m[1])
  }
  return events
}

/** Get the set of canonical events the manifest expects to be dispatched. */
function getExpectedCanonicalEvents(): Set<string> {
  const events = new Set<string>()
  for (const group of manifest) {
    events.add(group.event)
  }
  return events
}

async function loadAgentSettings(agent: AgentDef): Promise<Record<string, any> | CheckResult> {
  const file = Bun.file(agent.settingsPath)
  if (!(await file.exists())) {
    return {
      name: `${agent.name} config sync`,
      status: "warn",
      detail: "settings file not found — run: swiz install",
    }
  }
  try {
    return await file.json()
  } catch {
    return {
      name: `${agent.name} config sync`,
      status: "fail",
      detail: "settings file is malformed JSON",
    }
  }
}

export async function checkAgentConfigSync(agent: AgentDef): Promise<CheckResult> {
  const result = await loadAgentSettings(agent)
  if ("status" in result) return result as CheckResult
  const settings = result

  const hooksRaw = agent.wrapsHooks
    ? ((settings.hooks as Record<string, any>) ?? {})
    : ((settings[agent.hooksKey] as Record<string, any>) ?? {})
  const hooks = typeof hooksRaw === "object" && !Array.isArray(hooksRaw) ? hooksRaw : {}

  const installed = extractDispatchEvents(hooks)
  const expected = getExpectedCanonicalEvents()

  const missing: string[] = []
  for (const event of expected) {
    if (!installed.has(event)) {
      const agentEvent = translateEvent(event, agent)
      missing.push(`${event} (${agentEvent})`)
    }
  }

  if (missing.length === 0) {
    return {
      name: `${agent.name} config sync`,
      status: "pass",
      detail: `${installed.size} dispatch entries in sync with manifest`,
    }
  }
  return {
    name: `${agent.name} config sync`,
    status: "warn",
    detail: `${missing.length} missing dispatch: ${missing.join(", ")} — run: swiz install`,
  }
}

// ─── Plugin cache staleness check ────────────────────────────────────────────

interface PluginCacheInfo {
  pluginName: string
  sourcePath: string
  cachePath: string
  missingSkills: string[]
  extraSkills: string[]
  staleSkills: string[]
}

async function listSkillDirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
  } catch {
    return []
  }
}

async function findStaleSkills(
  sourceDir: string,
  cacheDir: string,
  shared: string[]
): Promise<string[]> {
  const stale: string[] = []
  for (const skill of shared) {
    const srcFile = Bun.file(join(sourceDir, skill, "SKILL.md"))
    const cacheFile = Bun.file(join(cacheDir, skill, "SKILL.md"))
    try {
      const [srcText, cacheText] = await Promise.all([srcFile.text(), cacheFile.text()])
      if (srcText !== cacheText) stale.push(skill)
    } catch {
      // If either file is unreadable, skip content comparison
    }
  }
  return stale
}

async function comparePluginSkills(
  pluginName: string,
  cachePath: string,
  sourcePath: string
): Promise<PluginCacheInfo | null> {
  const sourceSkillsDir = join(sourcePath, "skills")
  const cacheSkillsDir = join(cachePath, "skills")
  const sourceSkills = await listSkillDirs(sourceSkillsDir)
  if (sourceSkills.length === 0) return null
  const cacheSkills = await listSkillDirs(cacheSkillsDir)
  const cacheSet = new Set(cacheSkills)
  const sourceSet = new Set(sourceSkills)
  const missing = sourceSkills.filter((s) => !cacheSet.has(s))
  const extra = cacheSkills.filter((s) => !sourceSet.has(s))
  const shared = sourceSkills.filter((s) => cacheSet.has(s))
  const stale = await findStaleSkills(sourceSkillsDir, cacheSkillsDir, shared)
  if (missing.length === 0 && extra.length === 0 && stale.length === 0) return null
  return {
    pluginName,
    sourcePath: sourceSkillsDir,
    cachePath: cacheSkillsDir,
    missingSkills: missing,
    extraSkills: extra,
    staleSkills: stale,
  }
}

/**
 * Compare skills in the working-tree plugin source against the installed cache.
 * Returns info about each local plugin whose cached copy is out of sync.
 */
async function loadJsonFileSafe<T>(path: string): Promise<T | null> {
  const file = Bun.file(path)
  if (!(await file.exists())) return null
  try {
    return await file.json()
  } catch {
    return null
  }
}

async function checkPluginCacheStaleness(): Promise<PluginCacheInfo[]> {
  const installedPath = join(HOME, ".claude", "plugins", "installed_plugins.json")
  type InstalledPlugins = { version?: number; plugins?: Record<string, { installPath: string }[]> }
  const installed = await loadJsonFileSafe<InstalledPlugins>(installedPath)
  if (!installed?.plugins) return []

  const marketplacePath = join(SWIZ_ROOT, ".claude-plugin", "marketplace.json")
  type Marketplace = { name?: string; plugins?: { name: string; source: string }[] }
  const marketplace = await loadJsonFileSafe<Marketplace>(marketplacePath)
  if (!marketplace?.plugins || !marketplace.name) return []

  const results: PluginCacheInfo[] = []
  for (const plugin of marketplace.plugins) {
    const key = `${plugin.name}@${marketplace.name}`
    const entries = installed.plugins[key]
    if (!entries || entries.length === 0) continue
    const info = await comparePluginSkills(
      plugin.name,
      entries[0]!.installPath,
      join(SWIZ_ROOT, plugin.source)
    )
    if (info) results.push(info)
  }
  return results
}

function buildPluginCacheResults(infos: PluginCacheInfo[]): CheckResult[] {
  if (infos.length === 0) {
    return [
      {
        name: "Plugin cache sync",
        status: "pass",
        detail: "installed plugin skills match source",
      },
    ]
  }
  return infos.map((info) => {
    const parts: string[] = []
    if (info.missingSkills.length > 0) {
      parts.push(`missing from cache: ${info.missingSkills.join(", ")}`)
    }
    if (info.staleSkills.length > 0) {
      parts.push(`outdated in cache: ${info.staleSkills.join(", ")}`)
    }
    if (info.extraSkills.length > 0) {
      parts.push(`extra in cache: ${info.extraSkills.join(", ")}`)
    }
    return {
      name: `Plugin cache: ${info.pluginName}`,
      status: "warn" as const,
      detail: `${parts.join("; ")} — run: swiz doctor --fix`,
    }
  })
}

/** Copy missing and stale skills from plugin source into the cache directory. */
async function fixPluginCache(
  infos: PluginCacheInfo[]
): Promise<{ synced: string[]; updated: string[]; failed: { skill: string; error: string }[] }> {
  const synced: string[] = []
  const updated: string[] = []
  const failed: { skill: string; error: string }[] = []

  for (const info of infos) {
    for (const skill of info.missingSkills) {
      const src = join(info.sourcePath, skill)
      const dst = join(info.cachePath, skill)
      try {
        await cp(src, dst, { recursive: true })
        synced.push(skill)
      } catch (err: unknown) {
        failed.push({ skill, error: err instanceof Error ? err.message : String(err) })
      }
    }
    for (const skill of info.staleSkills) {
      const src = join(info.sourcePath, skill)
      const dst = join(info.cachePath, skill)
      try {
        await cp(src, dst, { recursive: true, force: true })
        updated.push(skill)
      } catch (err: unknown) {
        failed.push({ skill, error: err instanceof Error ? err.message : String(err) })
      }
    }
  }

  return { synced, updated, failed }
}

// ─── Auto-fix logic ─────────────────────────────────────────────────────────

interface AutoFixContext {
  fix: boolean
  results: CheckResult[]
  skillConflicts: SkillConflict[]
  invalidSkillEntries: InvalidSkillEntry[]
  pluginCacheInfos: PluginCacheInfo[]
  orphanedScripts: string[]
}

async function fixStaleConfigs(results: CheckResult[]): Promise<void> {
  const staleConfigs = results.filter(
    (r) =>
      r.name.endsWith("config sync") && r.status === "warn" && r.detail.includes("missing dispatch")
  )
  if (staleConfigs.length === 0) return
  console.log(`  ${BOLD}Auto-fixing stale configs...${RESET}\n`)
  const proc = Bun.spawn(["bun", "run", join(SWIZ_ROOT, "index.ts"), "install"], {
    stdout: "inherit",
    stderr: "inherit",
  })
  await proc.exited
  if (proc.exitCode === 0) {
    console.log(`  ${GREEN}✓ Configs updated successfully${RESET}\n`)
  } else {
    console.log(`  ${RED}✗ Install failed (exit ${proc.exitCode})${RESET}\n`)
  }
}

async function fixMissingConfigs(): Promise<void> {
  const missingConfigPaths = await findMissingConfigScriptPaths()
  if (missingConfigPaths.length === 0) return
  console.log(`  ${BOLD}Registering missing config scripts...${RESET}\n`)
  const regResult = await fixMissingConfigScripts(missingConfigPaths)
  for (const item of regResult.registered) {
    console.log(`  ${GREEN}✓${RESET} Registered stub: ${displayPath(item.path)}`)
  }
  for (const item of regResult.failed) {
    console.log(`  ${RED}✗${RESET} Failed to register ${displayPath(item.path)}: ${item.error}`)
  }
  if (regResult.registered.length > 0) console.log()
}

async function fixInvalidSkills(entries: InvalidSkillEntry[]): Promise<void> {
  if (entries.length === 0) return
  console.log(`  ${BOLD}Auto-fixing invalid skill entries...${RESET}\n`)
  const r = await fixInvalidSkillEntries(entries)
  for (const item of r.generated) {
    console.log(
      `  ${GREEN}✓${RESET} ${item.name}: generated default ${displayPath(item.skillPath)}`
    )
  }
  for (const item of r.nameFixed) {
    console.log(
      `  ${GREEN}✓${RESET} ${item.name}: updated name "${item.oldName}" → "${item.name}" in ${displayPath(item.skillPath)}`
    )
  }
  for (const item of r.categoryFixed) {
    console.log(
      `  ${GREEN}✓${RESET} ${item.name}: added category "${SKILL_PLACEHOLDER_CATEGORY}" to ${displayPath(item.skillPath)}`
    )
  }
  for (const item of r.failed) {
    console.log(
      `  ${RED}✗${RESET} ${item.name}: could not fix ${displayPath(item.originalDir)} (${item.error})`
    )
  }
  if (r.generated.length > 0 || r.nameFixed.length > 0 || r.categoryFixed.length > 0) {
    console.log()
  }
}

function getAgentIdForDir(dir: string): string | null {
  const home = getHomeDir()
  const expandedDir = dir.startsWith("~/") ? join(home, dir.slice(2)) : dir

  for (const adapter of listProviderAdapters()) {
    const expandedSkillDirs = adapter
      .getSkillDirs()
      .map((d) => (d.startsWith("~/") ? join(home, d.slice(2)) : d))
    if (expandedSkillDirs.includes(expandedDir)) return adapter.id
  }
  return null
}

function normalizeSkillContent(content: string): string {
  const withoutFrontmatter = content.replace(/^---[\s\S]*?^---[ \t]*\n?/m, "")
  return (
    withoutFrontmatter
      .replace(/\r\n/g, "\n")
      // Remove "Related Skills" section which often varies in local vs global versions
      .replace(/\n## Related Skills[\s\S]*?(?=\n#|\n##|$)/, "")
      // Remove "Task Completion Evidence Fields" footer if present
      .replace(/\n## Task Completion Evidence Fields[\s\S]*$/, "")
      .trim()
  )
}

async function areSkillsSame(
  active: SkillConflictEntry,
  overridden: SkillConflictEntry
): Promise<boolean> {
  const activeRaw = await Bun.file(active.path).text()
  const overriddenRaw = await Bun.file(overridden.path).text()

  const activeNormalized = normalizeSkillContent(activeRaw)
  const overriddenNormalized = normalizeSkillContent(overriddenRaw)

  if (activeNormalized === overriddenNormalized) {
    return true
  }

  const activeAgentId = getAgentIdForDir(active.dir) ?? "claude"
  const overriddenAgentId = getAgentIdForDir(overridden.dir) ?? "claude"

  // If the overridden version matches the active version after conversion, they are redundant
  const { content: converted } = convertSkillContent(
    overriddenRaw,
    getAgent(overriddenAgentId)!,
    getAgent(activeAgentId)!,
    AGENTS
  )

  return activeNormalized === normalizeSkillContent(converted)
}

function splitFrontmatter(content: string): { frontmatter: string[]; body: string[] } {
  const lines = content.split("\n")
  if (lines[0] !== "---") return { frontmatter: [], body: lines }
  const closeIdx = lines.indexOf("---", 1)
  if (closeIdx === -1) return { frontmatter: [], body: lines }
  return { frontmatter: lines.slice(1, closeIdx), body: lines.slice(closeIdx + 1) }
}

function lineDiff(aLines: string[], bLines: string[]): { added: string[]; removed: string[] } {
  const aSet = new Set(aLines)
  const bSet = new Set(bLines)
  return {
    added: aLines.filter((l) => !bSet.has(l)),
    removed: bLines.filter((l) => !aSet.has(l)),
  }
}

function formatDiffResult(
  countStr: string,
  section: string,
  totalChanged: number,
  allAdded: string[],
  allRemoved: string[]
): string {
  if (totalChanged <= 4) {
    const parts: string[] = []
    for (const l of allRemoved) parts.push(`-${l.trim().slice(0, 60)}`)
    for (const l of allAdded) parts.push(`+${l.trim().slice(0, 60)}`)
    return `${countStr} ${section}: ${parts.join(", ")}`
  }
  return `${countStr} in ${section}`
}

async function skillDiffSummary(activePath: string, overriddenPath: string): Promise<string> {
  try {
    const [activeText, overriddenText] = await Promise.all([
      Bun.file(activePath).text(),
      Bun.file(overriddenPath).text(),
    ])
    const active = splitFrontmatter(activeText)
    const overridden = splitFrontmatter(overriddenText)

    const fmDiff = lineDiff(active.frontmatter, overridden.frontmatter)
    const bodyDiff = lineDiff(active.body, overridden.body)

    const fmChanged = fmDiff.added.length > 0 || fmDiff.removed.length > 0
    const bodyChanged = bodyDiff.added.length > 0 || bodyDiff.removed.length > 0

    const totalAdded = fmDiff.added.length + bodyDiff.added.length
    const totalRemoved = fmDiff.removed.length + bodyDiff.removed.length
    const countStr = `+${totalAdded}/-${totalRemoved}`

    const section =
      fmChanged && !bodyChanged
        ? "frontmatter"
        : !fmChanged && bodyChanged
          ? "body"
          : "frontmatter+body"

    const allAdded = [...fmDiff.added, ...bodyDiff.added]
    const allRemoved = [...fmDiff.removed, ...bodyDiff.removed]
    return formatDiffResult(countStr, section, totalAdded + totalRemoved, allAdded, allRemoved)
  } catch {
    return ""
  }
}

async function fixSkillConflicts(conflicts: SkillConflict[], fix: boolean): Promise<void> {
  if (conflicts.length === 0) return

  if (!fix) {
    for (const conflict of conflicts) {
      for (const overridden of conflict.overridden) {
        if (await areSkillsSame(conflict.active, overridden)) {
          console.log(
            `  ${YELLOW}!${RESET} ${conflict.name}: redundant version at ${displayPath(dirname(overridden.path))} — remove manually`
          )
        } else {
          const diffStats = await skillDiffSummary(conflict.active.path, overridden.path)
          const diffSuffix = diffStats ? ` (${diffStats})` : ""
          console.log(
            `  ${YELLOW}!${RESET} ${conflict.name}: version at ${displayPath(dirname(overridden.path))} differs from active version${diffSuffix} — resolve manually`
          )
        }
      }
    }
    console.log()
    return
  }

  console.log(`  ${BOLD}Skill conflicts detected${RESET}. Removing overridden versions...\n`)
  for (const conflict of conflicts) {
    for (const overridden of conflict.overridden) {
      const skillDir = dirname(overridden.path)
      console.log(
        `  ${GREEN}✓${RESET} Removed ${displayPath(skillDir)} (shadowed by ${displayPath(dirname(conflict.active.path))})`
      )
      await defaultTrashPath(skillDir)
    }
  }
  console.log(`  ${GREEN}✓${RESET} Skill conflicts resolved${RESET}\n`)
}

async function fixOrphanedHookScripts(scripts: string[], fix: boolean): Promise<void> {
  if (scripts.length === 0) return

  if (!fix) {
    for (const script of scripts) {
      console.log(
        `  ${YELLOW}!${RESET} ${script}: not referenced by manifest or agent config — remove manually`
      )
    }
    console.log()
    return
  }

  console.log(`  ${BOLD}Orphaned hook scripts detected${RESET}. Adding to manifest...\n`)

  const manifestPath = join(process.cwd(), "src", "manifest.ts")
  let manifestContent: string
  try {
    manifestContent = await Bun.file(manifestPath).text()
  } catch (err) {
    console.log(`  ${RED}✗${RESET} Failed to read manifest.ts: ${err}`)
    return
  }

  for (const script of scripts) {
    // Derive variable name from filename: stop-git-status.ts -> stopGitStatus
    const varName = script
      .replace(/\.[^.]+$/, "") // remove extension
      .replace(/-(\w)/g, (_, c) => c.toUpperCase())
    const importLine = `import ${varName} from "../hooks/${script}"`

    // Add import if not present
    if (!manifestContent.includes(importLine)) {
      const debugLogImport = 'import { debugLog } from "./debug.ts"'
      if (manifestContent.includes(debugLogImport)) {
        manifestContent = manifestContent.replace(
          debugLogImport,
          `${importLine}\n${debugLogImport}`
        )
      } else {
        // Append at end of imports
        manifestContent = `${manifestContent}\n${importLine}`
      }
    }

    // Determine event from hook file content
    const hookPath = join(process.cwd(), "hooks", script)
    let hookContent: string
    try {
      hookContent = await Bun.file(hookPath).text()
    } catch {
      console.log(`  ${YELLOW}!${RESET} Cannot read ${script}, skipping`)
      continue
    }
    const eventMatch = hookContent.match(/event:\s*"([^"]+)"/)
    const event = eventMatch ? eventMatch[1] : null
    if (!event) {
      console.log(`  ${YELLOW}!${RESET} Could not determine event for ${script}, skipping`)
      continue
    }

    // Add hook entry to the appropriate group in manifest
    const groupPattern = new RegExp(
      `(\\{\\s*event:\\s*"${event}"[^}]*?hooks:\\s*\\[)(.*?)(\\])`,
      "s"
    )
    if (!groupPattern.test(manifestContent)) {
      console.log(`  ${YELLOW}!${RESET} No event group for "${event}" in manifest, skipping`)
      continue
    }

    // Check if hook already present
    if (manifestContent.includes(`hook: ${varName}`)) {
      console.log(`  ${YELLOW}!${RESET} ${script} already in manifest, skipping`)
      continue
    }

    manifestContent = manifestContent.replace(groupPattern, (_match, p1, p2, p3) => {
      // Insert new entry before closing bracket, preserving indentation
      const newEntry = `\n      { hook: ${varName} },`
      return p1 + p2 + newEntry + p3
    })

    console.log(`  ${GREEN}✓${RESET} Added ${script} to manifest (event: ${event})`)
  }

  // Write updated manifest
  try {
    await Bun.write(manifestPath, manifestContent)
    console.log(`  ${GREEN}✓${RESET} Orphaned hooks added to manifest${RESET}\n`)
  } catch (err) {
    console.log(`  ${RED}✗${RESET} Failed to write manifest.ts: ${err}`)
  }
}

async function fixStalePluginCache(infos: PluginCacheInfo[]): Promise<void> {
  if (infos.length === 0) return
  console.log(`  ${BOLD}Syncing plugin cache...${RESET}\n`)
  const r = await fixPluginCache(infos)
  for (const skill of r.synced) {
    console.log(`  ${GREEN}✓${RESET} ${skill}: copied to plugin cache`)
  }
  for (const skill of r.updated) {
    console.log(`  ${GREEN}✓${RESET} ${skill}: updated in plugin cache`)
  }
  for (const item of r.failed) {
    console.log(`  ${RED}✗${RESET} ${item.skill}: ${item.error}`)
  }
  if (r.synced.length > 0 || r.updated.length > 0) {
    console.log(`\n  ${DIM}Restart Claude Code to pick up the changes.${RESET}`)
    console.log()
  }
}

async function handleAutoFixes(ctx: AutoFixContext): Promise<void> {
  const { fix, results, skillConflicts, invalidSkillEntries, pluginCacheInfos, orphanedScripts } =
    ctx
  const hasStaleConfigs = results.some(
    (r) =>
      r.name.endsWith("config sync") && r.status === "warn" && r.detail.includes("missing dispatch")
  )
  if (fix) {
    await fixStaleConfigs(results)
    await fixMissingConfigs()
    await fixOrphanedHookScripts(orphanedScripts, fix)
    await fixSkillConflicts(skillConflicts, fix)
    await fixInvalidSkills(invalidSkillEntries)
    await fixStalePluginCache(pluginCacheInfos)
    return
  }
  if (
    hasStaleConfigs ||
    invalidSkillEntries.length > 0 ||
    pluginCacheInfos.length > 0 ||
    orphanedScripts.length > 0
  ) {
    const fixables = [
      hasStaleConfigs ? "stale configs" : null,
      invalidSkillEntries.length > 0 ? "invalid skill entries" : null,
      pluginCacheInfos.length > 0 ? "stale plugin cache" : null,
      orphanedScripts.length > 0 ? "orphaned hook scripts" : null,
    ]
      .filter(Boolean)
      .join(" and ")
    console.log(`  ${YELLOW}${fixables} detected. Run: swiz doctor --fix${RESET}\n`)
  }
}

// ─── Check collection ───────────────────────────────────────────────────────

interface DoctorCheckResults {
  results: CheckResult[]
  skillConflicts: SkillConflict[]
  invalidSkillEntries: InvalidSkillEntry[]
  pluginCacheInfos: PluginCacheInfo[]
  orphanedScripts: string[]
}

async function collectDoctorChecks(fix: boolean): Promise<DoctorCheckResults> {
  const results: CheckResult[] = []
  const ctx = { fix }

  // Run pluggable checks from the registry
  for (const check of DIAGNOSTIC_CHECKS) {
    const result = await check.run(ctx)
    if (Array.isArray(result)) {
      results.push(...result)
    } else {
      results.push(result)
    }
  }

  // Inline checks not yet extracted to the registry
  for (const agent of AGENTS) {
    results.push(await checkAgentBinary(agent))
    results.push(await checkAgentSettings(agent))
  }
  results.push(await checkHookScripts())
  results.push(await checkManifestHandlerPaths())
  const orphanedScripts = await findOrphanedHookScripts()
  results.push(buildOrphanedResult(orphanedScripts))
  results.push(await checkInstalledConfigScripts())
  results.push(await checkScriptExecutePermissions(fix))
  for (const agent of CONFIGURABLE_AGENTS) {
    results.push(await checkAgentConfigSync(agent))
  }
  const skillConflicts = await findSkillConflicts()
  results.push(...buildSkillConflictResults(skillConflicts))
  const projectSettings = await readProjectSettings(process.cwd())
  const allowedCategories = new Set(
    projectSettings?.allowedSkillCategories ?? DEFAULT_ALLOWED_SKILL_CATEGORIES
  )
  const invalidSkillEntries = await findInvalidSkillEntries(allowedCategories)
  results.push(...buildInvalidSkillResults(invalidSkillEntries))
  const pluginCacheInfos = await checkPluginCacheStaleness()
  results.push(...buildPluginCacheResults(pluginCacheInfos))
  results.push(await checkSwizSettings())
  return { results, skillConflicts, invalidSkillEntries, pluginCacheInfos, orphanedScripts }
}

// ─── Runner ─────────────────────────────────────────────────────────────────

function printResult(result: CheckResult): void {
  const icon = result.status === "pass" ? PASS : result.status === "warn" ? WARN : FAIL
  const detailColor = result.status === "fail" ? RED : result.status === "warn" ? YELLOW : DIM
  console.log(`  ${icon} ${BOLD}${result.name}${RESET}  ${detailColor}${result.detail}${RESET}`)
}

async function runDoctorChecks(args: string[]): Promise<void> {
  const fix = args.includes("--fix")
  console.log(`\n  ${BOLD}swiz doctor${RESET}\n`)

  const { results, skillConflicts, invalidSkillEntries, pluginCacheInfos, orphanedScripts } =
    await collectDoctorChecks(fix)

  for (const result of results) {
    printResult(result)
  }

  const failures = results.filter((r) => r.status === "fail")
  const warnings = results.filter((r) => r.status === "warn")
  const passes = results.filter((r) => r.status === "pass")

  console.log()
  console.log(
    `  ${GREEN}${passes.length} passed${RESET}` +
      (warnings.length > 0 ? `, ${YELLOW}${warnings.length} warnings${RESET}` : "") +
      (failures.length > 0 ? `, ${RED}${failures.length} failed${RESET}` : "")
  )
  console.log()

  await handleAutoFixes({
    fix,
    results,
    skillConflicts,
    invalidSkillEntries,
    pluginCacheInfos,
    orphanedScripts,
  })

  if (failures.length > 0) {
    throw new Error(
      `${failures.length} check(s) failed:\n` +
        failures.map((f) => `  - ${f.name}: ${f.detail}`).join("\n")
    )
  }
  await notifyDaemon(false)
}

/** Best-effort daemon notification after fixing issues (similar to settings write). */
async function notifyDaemon(jsonOutput: boolean): Promise<void> {
  try {
    const resp = await fetch(`http://127.0.0.1:${DAEMON_PORT}/health`, {
      signal: AbortSignal.timeout(500),
    })
    if (!resp.ok) return
    if (!jsonOutput) console.log("  Daemon notified of changes.")
  } catch {
    // Daemon not running — silently continue
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── Cleanup subcommand ─────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

const CLEANUP_HOME = getHomeDir()
const DAEMON_LABEL = SWIZ_DAEMON_LABEL

// ─── Path decoding ────────────────────────────────────────────────────────────

// Claude Code encodes project paths by replacing both '/' and '.' with '-'.
// This is lossy: a '-' in the encoded name could be from '/', '.', or a literal '-'.
// We resolve the ambiguity by walking the real filesystem and matching directory
// entries, using longest-match-first so "cheapshot-auto" wins over "cheapshot".

const readdirCache = new Map<string, string[]>()

async function readdirCached(dirPath: string): Promise<string[]> {
  const cached = readdirCache.get(dirPath)
  if (cached) return cached
  try {
    const entries = await readdir(dirPath)
    readdirCache.set(dirPath, entries)
    return entries
  } catch {
    return []
  }
}

export async function walkDecode(
  currentPath: string,
  remainingEncoded: string
): Promise<string | null> {
  if (!remainingEncoded) return currentPath
  if (!remainingEncoded.startsWith("-")) return null

  const encodedFromHere = remainingEncoded.slice(1) // strip leading '-'
  if (!encodedFromHere) return currentPath

  const entries = await readdirCached(currentPath)

  // Each filesystem entry encodes to its name with '/' and '.' replaced by '-'.
  // Find all entries whose encoding is a prefix of encodedFromHere, longest first.
  const candidates = entries
    .map((entry) => ({ entry, encoded: projectKeyFromCwd(entry) }))
    .filter(({ encoded }) => encodedFromHere.startsWith(encoded))
    .sort((a, b) => b.encoded.length - a.encoded.length)

  for (const { entry, encoded } of candidates) {
    const afterEntry = encodedFromHere.slice(encoded.length)
    if (afterEntry === "" || afterEntry.startsWith("-")) {
      const result = await walkDecode(join(currentPath, entry), afterEntry)
      if (result !== null) return result
    }
  }

  return null
}

export async function decodeProjectPath(
  encodedName: string,
  homeDir = CLEANUP_HOME
): Promise<string> {
  const encodedHome = projectKeyFromCwd(homeDir)
  if (!encodedName.startsWith(encodedHome)) return encodedName

  const encodedRest = encodedName.slice(encodedHome.length)
  if (!encodedRest) return "~"

  const decoded = await walkDecode(homeDir, encodedRest)
  if (decoded) {
    return decoded.startsWith(homeDir) ? `~${decoded.slice(homeDir.length)}` : decoded
  }

  // Fallback: simple replacement (may split literal hyphens)
  return `~${encodedRest.replace(/-/g, "/")}`
}

// Matches standard UUID v4 — session dirs only; named dirs (memory/, etc.) never match
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// Also match test-prefixed session IDs from recovery tests
const ORPHAN_SESSION_ID_RE =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|test-.*|unknown-.*)$/i
const JUNIE_SESSION_ID_RE = /^(session-\d{6}-\d{6}-[0-9a-z]{4}|test-.*)$/i

// ─── Cleanup helpers ─────────────────────────────────────────────────────────

async function dirSize(dirPath: string): Promise<number> {
  let total = 0
  try {
    const entries = await readdir(dirPath, { withFileTypes: true })
    for (const entry of entries) {
      const p = join(dirPath, entry.name)
      if (entry.isDirectory()) {
        total += await dirSize(p)
      } else {
        try {
          total += (await stat(p)).size
        } catch {
          // skip unreadable files
        }
      }
    }
  } catch {
    // skip unreadable dirs
  }
  return total
}

const trashDir = defaultTrashPath

type DaemonStopState = "not-installed" | "not-running" | "stopped" | "failed"

async function stopDaemonForCleanup(): Promise<DaemonStopState> {
  const plistPath = getLaunchAgentPlistPath(DAEMON_LABEL)
  if (!(await launchAgentExists(DAEMON_LABEL))) return "not-installed"
  if (!(await isLaunchAgentLoaded(DAEMON_LABEL))) return "not-running"
  return (await unloadLaunchAgent(plistPath)) === 0 ? "stopped" : "failed"
}

async function restartDaemonAfterCleanup(): Promise<boolean> {
  if (!(await launchAgentExists(DAEMON_LABEL))) return false
  return (await loadLaunchAgent(getLaunchAgentPlistPath(DAEMON_LABEL))) === 0
}

// ─── Claude backup detection ──────────────────────────────────────────────────

interface ClaudeBackupInfo {
  files: string[]
  sizeBytes: number
  fileCount: number
}

async function addBackupFile(
  filePath: string,
  target: { files: string[]; sizeBytes: number; fileCount: number }
): Promise<void> {
  try {
    const s = await stat(filePath)
    if (!s.isFile()) return
    target.files.push(filePath)
    target.sizeBytes += s.size
    target.fileCount += 1
  } catch {
    // Skip unreadable files.
  }
}

async function findClaudeBackups(claudeDir: string): Promise<ClaudeBackupInfo> {
  const backup: ClaudeBackupInfo = { files: [], sizeBytes: 0, fileCount: 0 }

  try {
    const entries = await readdir(claudeDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const name = entry.name
      if (name === "settings.json.backup" || name.startsWith("settings.json.bak")) {
        await addBackupFile(join(claudeDir, name), backup)
      }
    }
  } catch {
    // claudeDir doesn't exist or is unreadable
  }

  return backup
}

// ─── Gemini backup detection ──────────────────────────────────────────────────

interface GeminiBackupInfo {
  files: string[]
  sizeBytes: number
  fileCount: number
}

async function collectBakFiles(
  dirPath: string,
  target: GeminiBackupInfo,
  recurseIntoSubdirs: boolean
): Promise<void> {
  const entries = await readdir(dirPath, { withFileTypes: true }).catch(() => null)
  if (!entries) return

  for (const entry of entries) {
    const entryPath = join(dirPath, entry.name)
    if (entry.isDirectory()) {
      if (recurseIntoSubdirs) {
        await collectBakFiles(entryPath, target, false)
      }
      continue
    }

    if (entry.isFile() && entry.name.endsWith(".bak")) {
      await addBackupFile(entryPath, target)
    }
  }
}

async function findGeminiBackups(homeDir: string): Promise<GeminiBackupInfo> {
  const geminiDir = join(homeDir, ".gemini")
  const geminiSettingsBak = join(geminiDir, "settings.json.bak")
  const geminiTmpDir = join(geminiDir, "tmp")
  const backup: GeminiBackupInfo = { files: [], sizeBytes: 0, fileCount: 0 }

  // Check for settings.json.bak
  await addBackupFile(geminiSettingsBak, backup)

  // Check for *.bak files in ~/.gemini/tmp/**
  await collectBakFiles(geminiTmpDir, backup, true)

  return backup
}

// ─── Session discovery ───────────────────────────────────────────────────────

interface SessionInfo {
  sessionId: string
  paths: string[] // All paths associated with this session in projectsDir
  mtimeMs: number
  sizeBytes: number
  taskDirPath: string | null
  taskDirSizeBytes: number
}

interface OldTaskFileInfo {
  sessionId: string
  taskId: string
  status: string
  path: string
  sizeBytes: number
}

function sessionBytes(sessions: SessionInfo[]): number {
  return sessions.reduce((sum, session) => sum + session.sizeBytes + session.taskDirSizeBytes, 0)
}

function sessionTaskDirCount(sessions: SessionInfo[]): number {
  return sessions.filter((session) => session.taskDirPath !== null).length
}

function partitionByCutoff(
  sessions: SessionInfo[],
  cutoffMs: number
): { keep: SessionInfo[]; old: SessionInfo[] } {
  const keep: SessionInfo[] = []
  const old: SessionInfo[] = []
  for (const session of sessions) {
    if (session.mtimeMs < cutoffMs) old.push(session)
    else keep.push(session)
  }
  return { keep, old }
}

function backupLabel(scope: "Claude" | "Gemini", count: number): string {
  return `${scope} backup ${count === 1 ? "file" : "files"}`
}

function parseTaskAgeMs(task: {
  statusChangedAt?: string
  completionTimestamp?: string
}): number | null {
  const candidates = [task.completionTimestamp, task.statusChangedAt]
  for (const candidate of candidates) {
    if (!candidate) continue
    const ms = Date.parse(candidate)
    if (!Number.isNaN(ms)) return ms
  }
  return null
}

async function findOldTaskFiles(
  tasksDir: string,
  cutoffMs: number,
  allowedSessionIds?: Set<string>
): Promise<OldTaskFileInfo[]> {
  const oldTaskFiles: OldTaskFileInfo[] = []
  let sessionEntries: string[] = []
  try {
    sessionEntries = await readdir(tasksDir)
  } catch {
    return oldTaskFiles
  }

  async function readTaskFileJson(filePath: string) {
    try {
      return JSON.parse(await readFile(filePath, "utf-8")) as {
        id?: string
        status?: string
        statusChangedAt?: string
        completionTimestamp?: string
      }
    } catch {
      return null
    }
  }

  function isTaskJsonFile(file: string): boolean {
    return file.endsWith(".json") && !file.startsWith(".") && file !== "compact-snapshot.json"
  }

  async function statFileSafe(filePath: string) {
    try {
      const s = await stat(filePath)
      return s.isFile() ? s : null
    } catch {
      return null
    }
  }

  async function processTaskFile(
    sessionId: string,
    sessionDir: string,
    file: string,
    cutoffMs: number
  ): Promise<OldTaskFileInfo | null> {
    if (!isTaskJsonFile(file)) return null
    const filePath = join(sessionDir, file)
    const fileStat = await statFileSafe(filePath)
    if (!fileStat) return null

    const task = await readTaskFileJson(filePath)
    if (!task?.status) return null
    const taskMs = parseTaskAgeMs(task) ?? fileStat.mtimeMs
    if (taskMs >= cutoffMs) return null

    return {
      sessionId,
      taskId: task.id ?? file.slice(0, -5),
      status: task.status,
      path: filePath,
      sizeBytes: fileStat.size,
    }
  }

  async function processSessionDir(
    sessionId: string,
    tasksDir: string,
    cutoffMs: number
  ): Promise<OldTaskFileInfo[]> {
    const oldTaskFiles: OldTaskFileInfo[] = []
    const sessionDir = join(tasksDir, sessionId)
    let sessionDirStat: Awaited<ReturnType<typeof stat>>
    try {
      sessionDirStat = await stat(sessionDir)
    } catch {
      return oldTaskFiles
    }
    if (!sessionDirStat.isDirectory()) return oldTaskFiles

    let files: string[] = []
    try {
      files = await readdir(sessionDir)
    } catch {
      return oldTaskFiles
    }

    for (const file of files) {
      const taskFile = await processTaskFile(sessionId, sessionDir, file, cutoffMs)
      if (taskFile) {
        oldTaskFiles.push(taskFile)
      }
    }
    return oldTaskFiles
  }

  for (const sessionId of sessionEntries) {
    if (allowedSessionIds && !allowedSessionIds.has(sessionId)) continue

    const sessionTasks = await processSessionDir(sessionId, tasksDir, cutoffMs)
    if (sessionTasks.length > 0) {
      oldTaskFiles.push(...sessionTasks)
    }
  }

  return oldTaskFiles
}

async function trashSession(
  session: SessionInfo
): Promise<{ succeeded: number; failed: number; taskRemoved: boolean }> {
  let sessionPartSucceeded = false
  let failed = 0
  if (session.paths.length === 0) {
    sessionPartSucceeded = true
  } else {
    for (const p of session.paths) {
      if (await trashDir(p)) sessionPartSucceeded = true
      else failed++
    }
  }
  let taskRemoved = false
  if (session.taskDirPath) {
    if (await trashDir(session.taskDirPath)) {
      taskRemoved = true
    } else {
      failed++
      // If we failed to trash the only thing we have (orphaned task),
      // the whole session trashing failed.
      if (session.paths.length === 0) sessionPartSucceeded = false
    }
  }
  return { succeeded: sessionPartSucceeded ? 1 : 0, failed, taskRemoved }
}

function extractSessionId(entry: string, isDirectory: boolean): string | undefined {
  if (isDirectory && UUID_RE.test(entry)) return entry
  if (!isDirectory && entry.endsWith(".jsonl")) {
    const id = entry.slice(0, -6)
    if (UUID_RE.test(id)) return id
  }
  return undefined
}

async function buildSessionMap(
  projectDir: string,
  entries: string[]
): Promise<Map<string, { paths: string[]; mtime: number; size: number }>> {
  const sessionMap = new Map<string, { paths: string[]; mtime: number; size: number }>()
  for (const entry of entries) {
    const p = join(projectDir, entry)
    let s: Awaited<ReturnType<typeof stat>>
    try {
      s = await stat(p)
    } catch {
      continue
    }
    const isDirectory = s.isDirectory()
    const sessionId = extractSessionId(entry, isDirectory)
    if (!sessionId) continue
    const existing = sessionMap.get(sessionId) ?? { paths: [], mtime: 0, size: 0 }
    existing.paths.push(p)
    existing.mtime = Math.max(existing.mtime, s.mtimeMs)
    existing.size += isDirectory ? await dirSize(p) : s.size
    sessionMap.set(sessionId, existing)
  }
  return sessionMap
}

async function resolveTaskDirInfo(
  tasksDir: string,
  sessionId: string
): Promise<{ taskDirPath: string | null; taskDirSizeBytes: number }> {
  const taskDirPath = join(tasksDir, sessionId)
  try {
    const tStat = await stat(taskDirPath)
    if (tStat.isDirectory()) {
      return { taskDirPath, taskDirSizeBytes: await dirSize(taskDirPath) }
    }
  } catch {
    // No matching task directory — that's fine
  }
  return { taskDirPath: null, taskDirSizeBytes: 0 }
}

async function findJunieProjectSessions(
  junieSessionsDir: string,
  cutoffMs: number,
  projectFilter: string | undefined
): Promise<ProjectResult[]> {
  const results: ProjectResult[] = []
  let entries: Dirent[]
  try {
    entries = await readdir(junieSessionsDir, { withFileTypes: true })
  } catch {
    return results
  }

  const sessionDirs = entries
    .filter((e) => e.isDirectory() && JUNIE_SESSION_ID_RE.test(e.name))
    .map((e) => e.name)

  for (const sessionId of sessionDirs) {
    const sessionPath = join(junieSessionsDir, sessionId)
    const eventsPath = join(sessionPath, "events.jsonl")
    let s: Stats
    try {
      s = await stat(sessionPath)
    } catch {
      continue
    }

    // Determine if this session belongs to the filtered project
    if (projectFilter) {
      const projectKey = projectKeyFromCwd(projectFilter)
      const lines = await readLines(eventsPath, 20)
      let matches = false
      for (const line of lines) {
        if (line.includes(`"currentDirectory":"${projectFilter}"`) || line.includes(projectKey)) {
          matches = true
          break
        }
      }
      if (!matches) continue
    }

    const info: SessionInfo = {
      sessionId,
      paths: [sessionPath],
      mtimeMs: s.mtimeMs,
      sizeBytes: await dirSize(sessionPath),
      taskDirPath: null,
      taskDirSizeBytes: 0,
    }

    const { keep, old } = partitionByCutoff([info], cutoffMs)
    if (keep.length > 0 || old.length > 0) {
      results.push({ name: sessionId, keep, old, stale: false })
    }
  }

  return results
}

async function findSessions(
  projectDir: string,
  cutoffMs: number,
  tasksDir = createDefaultTaskStore().tasksDir
): Promise<{ keep: SessionInfo[]; old: SessionInfo[] }> {
  const keep: SessionInfo[] = []
  const old: SessionInfo[] = []

  let entries: string[]
  try {
    entries = await readdir(projectDir)
  } catch {
    return { keep, old }
  }

  const sessionMap = await buildSessionMap(projectDir, entries)

  for (const [sessionId, data] of sessionMap) {
    const { taskDirPath, taskDirSizeBytes } = await resolveTaskDirInfo(tasksDir, sessionId)
    const info: SessionInfo = {
      sessionId,
      paths: data.paths,
      mtimeMs: data.mtime,
      sizeBytes: data.size,
      taskDirPath,
      taskDirSizeBytes,
    }

    if (data.mtime < cutoffMs) {
      old.push(info)
    } else {
      keep.push(info)
    }
  }

  return { keep, old }
}

// ─── Cleanup arg parsing ─────────────────────────────────────────────────────

export interface CleanupArgs {
  olderThanMs: number
  olderThanLabel: string
  taskOlderThanMs: number | null
  taskOlderThanLabel: string | null
  dryRun: boolean
  projectFilter: string | undefined
  junieOnly?: boolean
}

/** Parse a time value like "7", "7d", or "48h" into milliseconds + display label. */
function parseOlderThan(value: string): { ms: number; label: string } {
  const hoursMatch = /^(\d+)h$/i.exec(value)
  if (hoursMatch) {
    const hours = parseInt(hoursMatch[1]!, 10)
    if (hours < 1) throw new Error("--older-than requires a positive value")
    return { ms: hours * 60 * 60 * 1000, label: `${hours} ${hours === 1 ? "hour" : "hours"}` }
  }

  const daysStr = /^(\d+)d?$/i.exec(value)?.[1] ?? ""
  const days = parseInt(daysStr, 10)
  if (Number.isNaN(days) || days < 1) {
    throw new Error("--older-than requires a positive integer, e.g. 30, 7d, or 48h")
  }
  return { ms: days * 24 * 60 * 60 * 1000, label: `${days} ${days === 1 ? "day" : "days"}` }
}

interface CleanupFlagState {
  olderThan: { ms: number; label: string }
  taskOlderThan: { ms: number; label: string } | null
  dryRun: boolean
  projectFilter: string | undefined
  junieOnly: boolean
}

function consumeCleanupFlag(
  arg: string,
  next: string | undefined,
  state: CleanupFlagState
): boolean {
  if (arg === "--dry-run") {
    state.dryRun = true
    return false
  }
  if (arg === "--junie-only") {
    state.junieOnly = true
    return false
  }
  if (arg === "--older-than" && next) {
    state.olderThan = parseOlderThan(next)
    return true
  }
  if (arg === "--task-older-than" && next) {
    state.taskOlderThan = parseOlderThan(next)
    return true
  }
  if (arg === "--project" && next) {
    state.projectFilter = next
    return true
  }
  return false
}

export function parseCleanupArgs(args: string[]): CleanupArgs {
  const state = {
    olderThan: parseOlderThan("30"),
    taskOlderThan: null as { ms: number; label: string } | null,
    dryRun: false,
    projectFilter: undefined as string | undefined,
    junieOnly: false,
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg) continue
    if (consumeCleanupFlag(arg, args[i + 1], state)) i++
  }

  return {
    olderThanMs: state.olderThan.ms,
    olderThanLabel: state.olderThan.label,
    taskOlderThanMs: state.taskOlderThan?.ms ?? null,
    taskOlderThanLabel: state.taskOlderThan?.label ?? null,
    dryRun: state.dryRun,
    projectFilter: state.projectFilter,
    junieOnly: state.junieOnly,
  }
}

// ─── Cleanup run helpers ─────────────────────────────────────────────────────

interface ProjectResult {
  name: string
  keep: SessionInfo[]
  old: SessionInfo[]
  stale: boolean
}

async function discoverProjectNames(
  projectsDir: string,
  projectFilter: string | undefined
): Promise<string[] | null> {
  let projectNames: string[]
  try {
    const entries = await readdir(projectsDir, { withFileTypes: true })
    projectNames = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((name) => !projectFilter || name === projectFilter)
      .sort()
  } catch {
    return null
  }
  if (projectFilter && projectNames.length === 0) {
    return null
  }
  return projectNames
}

async function scanProjects(
  projectNames: string[],
  projectsDir: string,
  cutoffMs: number,
  tasksDir: string
): Promise<ProjectResult[]> {
  const results: ProjectResult[] = []
  for (const name of projectNames) {
    const { keep, old } = await findSessions(join(projectsDir, name), cutoffMs, tasksDir)
    if (keep.length > 0 || old.length > 0) {
      results.push({ name, keep, old, stale: false })
    }
  }
  return results
}

async function markStaleProjects(results: ProjectResult[]): Promise<void> {
  const encodedHome = projectKeyFromCwd(CLEANUP_HOME)
  for (let i = 0; i < results.length; i++) {
    const name = results[i]!.name
    if (!name.startsWith(encodedHome)) continue
    const encodedRest = name.slice(encodedHome.length)
    if (!encodedRest) continue
    if ((await walkDecode(CLEANUP_HOME, encodedRest)) === null) {
      results[i]!.stale = true
      results[i]!.old = [...results[i]!.old, ...results[i]!.keep]
      results[i]!.keep = []
    }
  }
}

function collectSessionIds(results: ProjectResult[]): Set<string> {
  const ids = new Set<string>()
  for (const result of results) {
    for (const session of result.keep) ids.add(session.sessionId)
    for (const session of result.old) ids.add(session.sessionId)
  }
  return ids
}

async function getRealSessionMtime(taskDirPath: string): Promise<number | null> {
  let taskEntries: string[] = []
  try {
    taskEntries = await readdir(taskDirPath)
  } catch {
    return null
  }

  let maxMs = 0
  for (const file of taskEntries) {
    if (!file.endsWith(".json") || file.startsWith(".") || file === "compact-snapshot.json")
      continue
    const p = join(taskDirPath, file)
    try {
      const s = await stat(p)
      let taskMs = s.mtimeMs
      try {
        const taskJson = JSON.parse(await readFile(p, "utf-8"))
        const parsedMs = parseTaskAgeMs(taskJson)
        if (parsedMs !== null) taskMs = parsedMs
      } catch {
        /* invalid JSON — stick to file mtime */
      }
      if (taskMs > maxMs) maxMs = taskMs
    } catch {}
  }
  return maxMs > 0 ? maxMs : null
}

async function appendOrphanTasks(
  results: ProjectResult[],
  tasksDir: string,
  cutoffMs: number
): Promise<void> {
  const allKnownSessionIds = collectSessionIds(results)
  let taskEntries: string[] = []
  try {
    taskEntries = await readdir(tasksDir)
  } catch {}

  const orphans: SessionInfo[] = []
  for (const entry of taskEntries) {
    if (!ORPHAN_SESSION_ID_RE.test(entry) || allKnownSessionIds.has(entry)) continue
    const taskDirPath = join(tasksDir, entry)
    try {
      const s = await stat(taskDirPath)
      if (!s.isDirectory()) continue

      const realMtimeMs = (await getRealSessionMtime(taskDirPath)) ?? s.mtimeMs

      orphans.push({
        sessionId: entry,
        paths: [],
        mtimeMs: realMtimeMs,
        sizeBytes: 0,
        taskDirPath,
        taskDirSizeBytes: await dirSize(taskDirPath),
      })
    } catch {
      /* skip unreadable task directories */
    }
  }

  if (orphans.length > 0) {
    const { keep, old } = partitionByCutoff(orphans, cutoffMs)
    if (keep.length > 0 || old.length > 0) {
      results.push({ name: "(orphaned tasks)", keep, old, stale: true })
    }
  }
}

interface BackupInfo {
  fileCount: number
  sizeBytes: number
  files: string[]
}

interface CleanupTotals {
  totalOldCount: number
  totalOldBytes: number
  totalOldTaskDirs: number
  totalBytes: number
  nothingToTrash: boolean
}

function printBackupSection(label: string, backups: BackupInfo): void {
  if (backups.fileCount === 0) return
  console.log(`  ${BOLD}~/.${label.toLowerCase()}/ (backup artifacts)${RESET}`)
  console.log(
    `    ${YELLOW}${backups.fileCount} backup ${backups.fileCount === 1 ? "file" : "files"}${RESET} (${formatBytes(backups.sizeBytes)})`
  )
  console.log()
}

interface CleanupReportOpts {
  results: ProjectResult[]
  claudeBackups: BackupInfo
  geminiBackups: BackupInfo
  oldTaskFiles: Array<{ path: string; sizeBytes: number }>
  oldTaskBytes: number
  taskCutoffMs: number | null
  cleanupArgs: CleanupArgs
}

interface ProjectTotals {
  totalOldCount: number
  totalOldBytes: number
  totalOldTaskDirs: number
}

async function printProjectTable(
  results: ProjectResult[],
  junieOnly = false
): Promise<ProjectTotals> {
  const decodedNames = await Promise.all(
    results.map((r) =>
      r.name.startsWith("(") || UUID_RE.test(r.name) || JUNIE_SESSION_ID_RE.test(r.name)
        ? Promise.resolve(r.name)
        : decodeProjectPath(r.name)
    )
  )
  const maxNameLen = Math.max(...decodedNames.map((n) => n.length), 20)

  console.log()
  if (junieOnly) {
    console.log(`  ${BOLD}~/.junie/sessions/${RESET}`)
  } else {
    console.log(`  ${BOLD}Agent Sessions${RESET}`)
  }

  let totalOldCount = 0
  let totalOldBytes = 0
  let totalOldTaskDirs = 0

  for (let i = 0; i < results.length; i++) {
    const { keep, old, stale } = results[i]!
    const displayName = decodedNames[i]!
    const total = keep.length + old.length
    const keepBytes = sessionBytes(keep)
    const oldBytes = sessionBytes(old)
    const oldTaskDirCount = sessionTaskDirCount(old)
    totalOldCount += old.length
    totalOldBytes += oldBytes
    totalOldTaskDirs += oldTaskDirCount

    const staleSuffix = stale ? ` ${DIM}(path gone)${RESET}` : ""
    const trashPart =
      old.length > 0
        ? `${YELLOW}${old.length} trashable${RESET} (${formatBytes(oldBytes)})`
        : `${DIM}0 trashable${RESET}`
    const keepPart = `${keep.length} kept (${formatBytes(keepBytes)})`
    console.log(
      `    ${displayName.padEnd(maxNameLen + 2)} ${String(total).padStart(3)} sessions  →  ${keepPart}, ${trashPart}${staleSuffix}`
    )
  }

  return { totalOldCount, totalOldBytes, totalOldTaskDirs }
}

function printTaskSection(
  oldTaskFiles: Array<{ path: string; sizeBytes: number }>,
  oldTaskBytes: number,
  taskLabel: string
): void {
  console.log(`  ${BOLD}~/.claude/tasks/ (old task files)${RESET}`)
  const taskCountLabel = oldTaskFiles.length === 1 ? "file" : "files"
  const taskPart =
    oldTaskFiles.length > 0
      ? `${YELLOW}${oldTaskFiles.length} task ${taskCountLabel}${RESET} (${formatBytes(oldTaskBytes)})`
      : `${DIM}0 task files${RESET}`
  console.log(`    ${taskPart} older than ${taskLabel}`)
  console.log()
}

function buildTotalSummaryLine(
  totals: ProjectTotals,
  oldTaskFiles: Array<{ path: string; sizeBytes: number }>,
  claudeBackups: BackupInfo,
  geminiBackups: BackupInfo,
  totalBytes: number
): string {
  const taskSuffix =
    totals.totalOldTaskDirs > 0
      ? ` + ${totals.totalOldTaskDirs} task ${totals.totalOldTaskDirs === 1 ? "dir" : "dirs"}`
      : ""
  const claudePart =
    claudeBackups.fileCount > 0
      ? ` + ${claudeBackups.fileCount} ${backupLabel("Claude", claudeBackups.fileCount)}`
      : ""
  const geminiPart =
    geminiBackups.fileCount > 0
      ? ` + ${geminiBackups.fileCount} ${backupLabel("Gemini", geminiBackups.fileCount)}`
      : ""
  const oldTaskPart = oldTaskFiles.length > 0 ? ` + ${oldTaskFiles.length} old task files` : ""
  return (
    `  Total: ${BOLD}${totals.totalOldCount} sessions${RESET}` +
    `${taskSuffix}${oldTaskPart}${claudePart}${geminiPart}` +
    ` trashable, ~${formatBytes(totalBytes)}`
  )
}

async function printCleanupReport(opts: CleanupReportOpts): Promise<CleanupTotals> {
  const {
    results,
    claudeBackups,
    geminiBackups,
    oldTaskFiles,
    oldTaskBytes,
    taskCutoffMs,
    cleanupArgs,
  } = opts

  const totals = await printProjectTable(results, cleanupArgs.junieOnly)

  console.log()
  printBackupSection("claude", claudeBackups)
  printBackupSection("gemini", geminiBackups)

  if (taskCutoffMs !== null) {
    const taskLabel = cleanupArgs.taskOlderThanLabel ?? "specified window"
    printTaskSection(oldTaskFiles, oldTaskBytes, taskLabel)
  }

  const totalBytes =
    totals.totalOldBytes + oldTaskBytes + claudeBackups.sizeBytes + geminiBackups.sizeBytes
  const nothingToTrash =
    totals.totalOldCount === 0 &&
    oldTaskFiles.length === 0 &&
    claudeBackups.fileCount === 0 &&
    geminiBackups.fileCount === 0

  if (nothingToTrash) {
    console.log(
      `  ${GREEN}No sessions older than ${cleanupArgs.olderThanLabel}, no old task files, and no Claude or Gemini backups found.${RESET}`
    )
    return { ...totals, totalBytes, nothingToTrash: true }
  }

  console.log(buildTotalSummaryLine(totals, oldTaskFiles, claudeBackups, geminiBackups, totalBytes))
  console.log()

  return { ...totals, totalBytes, nothingToTrash: false }
}

async function trashFileList(files: string[]): Promise<{ removed: number; failed: number }> {
  let removed = 0
  let failed = 0
  for (const file of files) {
    if (await trashDir(file)) removed++
    else failed++
  }
  return { removed, failed }
}

interface ExecuteCleanupOpts {
  results: ProjectResult[]
  claudeBackups: BackupInfo
  geminiBackups: BackupInfo
  oldTaskFiles: Array<{ path: string; sizeBytes: number }>
  totalOldCount: number
  totalOldTaskDirs: number
  totalBytes: number
}

function buildCleanupSuffix(opts: ExecuteCleanupOpts): string {
  const taskSuffix =
    opts.totalOldTaskDirs > 0
      ? ` + ${opts.totalOldTaskDirs} task ${opts.totalOldTaskDirs === 1 ? "dir" : "dirs"}`
      : ""
  const claudePart =
    opts.claudeBackups.fileCount > 0
      ? ` + ${opts.claudeBackups.fileCount} ${backupLabel("Claude", opts.claudeBackups.fileCount)}`
      : ""
  const geminiPart =
    opts.geminiBackups.fileCount > 0
      ? ` + ${opts.geminiBackups.fileCount} ${backupLabel("Gemini", opts.geminiBackups.fileCount)}`
      : ""
  const oldTaskPart =
    opts.oldTaskFiles.length > 0 ? ` + ${opts.oldTaskFiles.length} old task files` : ""
  return `${taskSuffix}${oldTaskPart}${claudePart}${geminiPart}`
}

async function trashAllSessions(
  results: ProjectResult[]
): Promise<{ succeeded: number; failed: number; taskDirsRemoved: number }> {
  let succeeded = 0
  let failed = 0
  let taskDirsRemoved = 0
  for (const { old } of results) {
    for (const session of old) {
      const r = await trashSession(session)
      succeeded += r.succeeded
      failed += r.failed
      if (r.taskRemoved) taskDirsRemoved++
    }
  }
  return { succeeded, failed, taskDirsRemoved }
}

function buildCleanupNotes(
  sessions: { taskDirsRemoved: number },
  tasks: { removed: number },
  claude: { removed: number },
  gemini: { removed: number }
): string {
  const parts: string[] = []
  if (sessions.taskDirsRemoved > 0) parts.push(`${sessions.taskDirsRemoved} task dir(s)`)
  if (tasks.removed > 0)
    parts.push(`${tasks.removed} old task ${tasks.removed === 1 ? "file" : "files"}`)
  if (claude.removed > 0) parts.push(`${claude.removed} ${backupLabel("Claude", claude.removed)}`)
  if (gemini.removed > 0) parts.push(`${gemini.removed} ${backupLabel("Gemini", gemini.removed)}`)
  return parts.length > 0 ? ` + ${parts.join(" + ")}` : ""
}

function printCleanupResult(
  sessions: { succeeded: number; failed: number; taskDirsRemoved: number },
  tasks: { removed: number; failed: number },
  claude: { removed: number; failed: number },
  gemini: { removed: number; failed: number },
  totalBytes: number
): void {
  const notes = buildCleanupNotes(sessions, tasks, claude, gemini)
  console.log(
    `  ${GREEN}${BOLD}Done.${RESET} ${sessions.succeeded} session(s)${notes}` +
      ` moved to Trash (~${formatBytes(totalBytes)} reclaimed).`
  )

  const totalFailed = sessions.failed + tasks.failed + claude.failed + gemini.failed
  if (totalFailed > 0) {
    const parts = [
      sessions.failed > 0 ? `${sessions.failed} session(s)` : "",
      tasks.failed > 0 ? `${tasks.failed} old task ${tasks.failed === 1 ? "file" : "files"}` : "",
      claude.failed > 0 ? `${claude.failed} ${backupLabel("Claude", claude.failed)}` : "",
      gemini.failed > 0 ? `${gemini.failed} ${backupLabel("Gemini", gemini.failed)}` : "",
    ]
      .filter((s) => s)
      .join(" + ")
    console.log(
      `  ${YELLOW}${parts} could not be trashed — is the \`trash\` CLI installed?${RESET}`
    )
  }
}

async function executeCleanup(opts: ExecuteCleanupOpts): Promise<void> {
  const daemonStopState = await stopDaemonForCleanup()
  if (daemonStopState === "stopped") {
    console.log(`  ${DIM}Stopped ${DAEMON_LABEL} before cleanup.${RESET}`)
  } else if (daemonStopState === "failed") {
    console.log(`  ${YELLOW}Warning: failed to stop ${DAEMON_LABEL}; continuing cleanup.${RESET}`)
  }

  const suffix = buildCleanupSuffix(opts)
  try {
    console.log(`  Moving ${opts.totalOldCount} session(s)${suffix} to Trash...`)
    const sessions = await trashAllSessions(opts.results)
    const claude = await trashFileList(opts.claudeBackups.files)
    const gemini = await trashFileList(opts.geminiBackups.files)
    const tasks = await trashFileList(opts.oldTaskFiles.map((t) => t.path))

    console.log()
    printCleanupResult(sessions, tasks, claude, gemini, opts.totalBytes)
  } finally {
    if (daemonStopState === "stopped") {
      const restarted = await restartDaemonAfterCleanup()
      if (restarted) {
        console.log(`  ${DIM}Restarted ${DAEMON_LABEL} after cleanup.${RESET}`)
      } else {
        console.log(
          `  ${YELLOW}Warning: failed to restart ${DAEMON_LABEL}; run 'swiz daemon --install' if needed.${RESET}`
        )
      }
    }
  }
}

// ─── Cleanup runner ─────────────────────────────────────────────────────────

async function gatherCleanupData(cleanupArgs: ReturnType<typeof parseCleanupArgs>) {
  const homeDir = getHomeDir()
  const claudeDir = join(homeDir, ".claude")
  const projectsDir = join(claudeDir, "projects")
  const tasksDir = join(claudeDir, "tasks")
  const junieSessionsDir = join(homeDir, ".junie", "sessions")

  const cutoffMs = Date.now() - cleanupArgs.olderThanMs
  const taskCutoffMs = cleanupArgs.taskOlderThanMs ? Date.now() - cleanupArgs.taskOlderThanMs : null

  let results: ProjectResult[] = []

  if (!cleanupArgs.junieOnly) {
    const projectNames = await discoverProjectNames(projectsDir, cleanupArgs.projectFilter)
    if (projectNames) {
      const claudeResults = await scanProjects(projectNames, projectsDir, cutoffMs, tasksDir)
      await markStaleProjects(claudeResults)
      results = results.concat(claudeResults)
    } else if (cleanupArgs.projectFilter) {
      // If project filter was specified but no Claude project found,
      // it's still possible it's a Junie project, so we don't return early.
    } else {
      // No Claude projects directory found, still scan Junie.
    }
  }

  const junieResults = await findJunieProjectSessions(
    junieSessionsDir,
    cutoffMs,
    cleanupArgs.projectFilter
  )
  results = results.concat(junieResults)

  if (results.length === 0 && !cleanupArgs.junieOnly) {
    // If no explicit results yet, we might still have orphans or backups
  }

  const scopedSessionIds = collectSessionIds(results)
  const oldTaskFiles =
    taskCutoffMs === null
      ? []
      : await findOldTaskFiles(
          tasksDir,
          taskCutoffMs,
          cleanupArgs.projectFilter ? scopedSessionIds : undefined
        )
  const oldTaskBytes = oldTaskFiles.reduce((sum, task) => sum + task.sizeBytes, 0)

  if (!cleanupArgs.projectFilter && !cleanupArgs.junieOnly) {
    await appendOrphanTasks(results, tasksDir, cutoffMs)
  }

  const [claudeBackups, geminiBackups] = await Promise.all([
    findClaudeBackups(claudeDir),
    findGeminiBackups(homeDir),
  ])
  return { results, oldTaskFiles, oldTaskBytes, taskCutoffMs, claudeBackups, geminiBackups }
}

export async function runCleanupCommand(args: string[]): Promise<void> {
  const cleanupArgs = parseCleanupArgs(args)
  const data = await gatherCleanupData(cleanupArgs)
  if (!data) return
  const { results, claudeBackups, geminiBackups, oldTaskFiles, oldTaskBytes, taskCutoffMs } = data

  if (results.length === 0 && claudeBackups.fileCount === 0 && geminiBackups.fileCount === 0) {
    if (!cleanupArgs.projectFilter) {
      console.log(`No session directories found (older than ${cleanupArgs.olderThanLabel}).`)
      console.log(`No Claude or Gemini backup artifacts found.`)
    }
    return
  }

  const totals = await printCleanupReport({
    results,
    claudeBackups,
    geminiBackups,
    oldTaskFiles,
    oldTaskBytes,
    taskCutoffMs,
    cleanupArgs,
  })

  if (totals.nothingToTrash) return
  if (cleanupArgs.dryRun) {
    console.log(`  ${DIM}Run without --dry-run to proceed.${RESET}`)
    return
  }

  await executeCleanup({
    results,
    claudeBackups,
    geminiBackups,
    oldTaskFiles,
    totalOldCount: totals.totalOldCount,
    totalOldTaskDirs: totals.totalOldTaskDirs,
    totalBytes: totals.totalBytes,
  })
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── Command ────────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

export const doctorCommand: Command = {
  name: "doctor",
  description: "Check environment health, fix issues, and clean up old session data",
  usage: "swiz doctor [--fix] | swiz doctor cleanup [--older-than <time>] [--dry-run]",
  options: [
    { flags: "--fix", description: "Auto-fix stale agent configs by running swiz install" },
    {
      flags: "cleanup",
      description: "Remove old Claude Code/Junie session data and Gemini backup artifacts",
    },
  ],
  async run(args) {
    if (args[0] === "cleanup") {
      await runCleanupCommand(args.slice(1))
      return
    }
    await runDoctorChecks(args)
  },
}
