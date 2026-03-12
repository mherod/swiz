import { chmod, cp, mkdir, readdir, rename, rm, stat } from "node:fs/promises"
import { dirname, join } from "node:path"
import { AGENTS, type AgentDef, CONFIGURABLE_AGENTS, translateEvent } from "../agents.ts"
import { suggest } from "../fuzzy.ts"
import { getHomeDirWithFallback } from "../home.ts"
import { manifest } from "../manifest.ts"
import { readProjectSettings, readSwizSettings } from "../settings.ts"
import {
  findSkillConflicts,
  parseFrontmatterField,
  SKILL_PRECEDENCE,
  type SkillConflict,
} from "../skill-utils.ts"
import type { Command } from "../types.ts"

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

import { BOLD, DIM, GREEN, RED, RESET, YELLOW } from "../ansi.ts"

const HOME = getHomeDirWithFallback("")

const PASS = `${GREEN}✓${RESET}`
const FAIL = `${RED}✗${RESET}`
const WARN = `${YELLOW}!${RESET}`

interface CheckResult {
  name: string
  status: "pass" | "warn" | "fail"
  detail: string
}

// ─── Individual checks ──────────────────────────────────────────────────────

async function checkBun(): Promise<CheckResult> {
  return {
    name: "Bun runtime",
    status: "pass",
    detail: `v${Bun.version}`,
  }
}

function checkAgentBinary(agent: AgentDef): CheckResult {
  const proc = Bun.spawnSync(["which", agent.binary])
  const found = proc.exitCode === 0
  const path = found ? new TextDecoder().decode(proc.stdout).trim() : null

  return {
    name: `${agent.name} binary`,
    status: found ? "pass" : "warn",
    detail: found ? path! : `"${agent.binary}" not found on PATH`,
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
  const hookFiles = [...new Set(manifest.flatMap((g) => g.hooks.map((h) => h.file)))]

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
  const manifestFiles = new Set(manifest.flatMap((g) => g.hooks.map((h) => h.file)))

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

async function checkGhAuth(): Promise<CheckResult> {
  const whichProc = Bun.spawnSync(["which", "gh"])
  if (whichProc.exitCode !== 0) {
    return {
      name: "GitHub CLI auth",
      status: "warn",
      detail: "gh not installed — some hooks require it",
    }
  }

  const proc = Bun.spawn(["gh", "auth", "status"], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited

  if (proc.exitCode === 0) {
    const output = (stdout + stderr).trim()
    const accountMatch = output.match(/Logged in to .+ account (\S+)/)
    const account = accountMatch?.[1] ?? "authenticated"
    return {
      name: "GitHub CLI auth",
      status: "pass",
      detail: account,
    }
  }

  return {
    name: "GitHub CLI auth",
    status: "fail",
    detail: "not authenticated — run: gh auth login",
  }
}

async function checkTtsBackend(): Promise<CheckResult> {
  const platform = process.platform

  if (platform === "darwin") {
    const proc = Bun.spawnSync(["which", "say"])
    if (proc.exitCode === 0) {
      return { name: "TTS backend", status: "pass", detail: "macOS say" }
    }
    return { name: "TTS backend", status: "warn", detail: "macOS say not found" }
  }

  if (platform === "win32") {
    return { name: "TTS backend", status: "pass", detail: "PowerShell SpeechSynthesizer" }
  }

  // Linux: check for espeak-ng, espeak, spd-say
  const linuxEngines = ["espeak-ng", "espeak", "spd-say"]
  for (const engine of linuxEngines) {
    const proc = Bun.spawnSync(["which", engine])
    if (proc.exitCode === 0) {
      return { name: "TTS backend", status: "pass", detail: engine }
    }
  }

  return {
    name: "TTS backend",
    status: "warn",
    detail: "no TTS engine found — install espeak-ng, espeak, or spd-say",
  }
}

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
      `precedence=${precedence}`,
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
      if (!entry.isDirectory()) continue
      if (entry.name.startsWith(".")) continue // skip hidden/temp dirs (e.g. .unison.*)
      if (DISABLED_BY_SWIZ_RE.test(entry.name)) continue // skip disabled skill dirs
      const entryDir = join(skillDir, entry.name)
      const skillPath = join(entryDir, "SKILL.md")
      const file = Bun.file(skillPath)
      if (!(await file.exists())) {
        invalid.push({ name: entry.name, skillDir, entryDir, reason: "missing SKILL.md" })
        continue
      }
      const content = await file.text()
      if (!content.trim()) {
        invalid.push({ name: entry.name, skillDir, entryDir, reason: "empty SKILL.md" })
        continue
      }
      if (!/^---/m.test(content)) {
        invalid.push({
          name: entry.name,
          skillDir,
          entryDir,
          reason: "SKILL.md has no frontmatter block (expected --- delimiters)",
        })
        continue
      }
      // Collect all field-level errors in a single pass (no early exit after this point)
      let hasContentIssues = false
      const missing = REQUIRED_SKILL_FIELDS.filter((f) => !parseFrontmatterField(content, f))
      if (missing.length > 0) {
        invalid.push({
          name: entry.name,
          skillDir,
          entryDir,
          reason: `missing required frontmatter field(s): ${missing.join(", ")}`,
        })
        hasContentIssues = true
        // Continue checking fields that do exist — do NOT early-exit here
      }
      // Name-match check (only when name field is present)
      const rawName = parseFrontmatterField(content, "name") ?? ""
      if (rawName) {
        // Strip surrounding quotes authors sometimes include: name: "my-skill"
        const unquotedName = rawName.replace(/^["']|["']$/g, "")
        if (unquotedName !== entry.name) {
          invalid.push({
            name: entry.name,
            skillDir,
            entryDir,
            reason: `frontmatter name "${unquotedName}" does not match directory name "${entry.name}"`,
          })
          hasContentIssues = true
        }
      }
      // Placeholder description check (only when description field is present)
      const description = parseFrontmatterField(content, "description")
      if (description?.trim() === SKILL_PLACEHOLDER_DESCRIPTION) {
        invalid.push({
          name: entry.name,
          skillDir,
          entryDir,
          reason: `description is the generated placeholder — update SKILL.md with a real description`,
        })
        hasContentIssues = true
      }
      // Category check — only run when no other field-level issues found
      if (!hasContentIssues) {
        const rawCategory = parseFrontmatterField(content, "category")
        if (!rawCategory) {
          invalid.push({ name: entry.name, skillDir, entryDir, reason: MISSING_CATEGORY_REASON })
        } else {
          const cat = rawCategory.trim()
          if (!allowedCategories.has(cat)) {
            const suggestion = suggest(cat, allowedCategories)
            const hint = suggestion ? ` (did you mean: "${suggestion}"?)` : ""
            invalid.push({
              name: entry.name,
              skillDir,
              entryDir,
              reason: `${INVALID_CATEGORY_REASON_PREFIX}${cat}"${hint} — allowed: ${[...allowedCategories].sort().join(", ")}`,
            })
          }
        }
      }
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
interface DisabledSkillRestore {
  name: string
  oldDir: string
  newDir: string
}

const NAME_MISMATCH_PREFIX = 'frontmatter name "'
const MISSING_SKILL_MD_REASON = "missing SKILL.md"
const MISSING_CATEGORY_REASON = "missing category field"
const INVALID_CATEGORY_REASON_PREFIX = 'unknown category "'
/** Matches directories renamed by swiz to disable a skill, e.g. "my-skill.disabled-by-swiz-20260312143027". */
const DISABLED_BY_SWIZ_RE = /\.disabled-by-swiz-\d{14}$/
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
    const oldName = rawName.replace(/^["']|["']$/g, "")
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

/** Scan all skill dirs for .disabled-by-swiz-* directories that need restoring. */
async function findDisabledSkillDirs(): Promise<DisabledSkillRestore[]> {
  const restores: DisabledSkillRestore[] = []
  for (const skillDir of SKILL_PRECEDENCE) {
    let entries: import("node:fs").Dirent[]
    try {
      entries = await readdir(skillDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (!DISABLED_BY_SWIZ_RE.test(entry.name)) continue
      const baseName = entry.name.replace(DISABLED_BY_SWIZ_RE, "")
      restores.push({
        name: baseName,
        oldDir: join(skillDir, entry.name),
        newDir: join(skillDir, baseName),
      })
    }
  }
  return restores
}

/** Restore a disabled skill directory: rename dir back and fix frontmatter name.
 *  If the target directory already exists, the disabled directory is removed
 *  (the existing non-disabled version is kept). */
async function restoreDisabledSkillDir(restore: DisabledSkillRestore): Promise<boolean> {
  try {
    // If target already exists, just remove the disabled directory
    const targetExists = await Bun.file(join(restore.newDir, "SKILL.md")).exists()
    if (targetExists) {
      await rm(restore.oldDir, { recursive: true, force: true })
      return true
    }
    await rename(restore.oldDir, restore.newDir)
    const skillPath = join(restore.newDir, "SKILL.md")
    const file = Bun.file(skillPath)
    if (await file.exists()) {
      const content = await file.text()
      const updated = content.replace(/^(name:\s*)["']?[^"'\n]+["']?/m, `$1${restore.name}`)
      await Bun.write(skillPath, updated)
    }
    return true
  } catch {
    return false
  }
}

/** Repair invalid skill entries in-place.
 *  - missing SKILL.md    → generate a default stub
 *  - name mismatch       → update name: field in place
 *  - missing category    → insert category: uncategorized after description line
 *  - disabled dirs       → rename back to base name and fix frontmatter
 *  - everything else     → reported as unfixable (no auto-disable) */
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
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
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
function collectHookCommands(hooks: Record<string, unknown>): string[] {
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

/** Collect deduplicated script file paths referenced in installed agent hook configs. */
async function collectInstalledConfigScriptPaths(): Promise<string[]> {
  const paths: string[] = []
  for (const agent of CONFIGURABLE_AGENTS) {
    const file = Bun.file(agent.settingsPath)
    if (!(await file.exists())) continue
    let settings: Record<string, unknown>
    try {
      settings = await file.json()
    } catch {
      continue
    }
    const hooksRaw = agent.wrapsHooks
      ? ((settings.hooks as Record<string, unknown>) ?? {})
      : ((settings[agent.hooksKey] as Record<string, unknown>) ?? {})
    const hooks = typeof hooksRaw === "object" && !Array.isArray(hooksRaw) ? hooksRaw : {}
    for (const cmd of collectHookCommands(hooks)) {
      paths.push(...extractScriptPaths(cmd))
    }
  }
  return [...new Set(paths)]
}

/** Verify that all executable script paths (manifest + config) exist and are executable. */
async function checkInstalledConfigScripts(): Promise<CheckResult> {
  // Build source map so error messages can attribute each path to manifest or config
  const pathSource = new Map<string, "manifest" | "config">()
  for (const group of manifest) {
    for (const hook of group.hooks) {
      pathSource.set(join(HOOKS_DIR, hook.file), "manifest")
    }
  }
  for (const p of await collectInstalledConfigScriptPaths()) {
    if (!pathSource.has(p)) pathSource.set(p, "config")
  }

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
      if ((s.mode & 0o100) === 0) {
        notExecutable.push(label)
      }
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
      paths.push(join(HOOKS_DIR, hook.file))
    }
  }
  // Script paths referenced in installed agent configs (via shared helper)
  paths.push(...(await collectInstalledConfigScriptPaths()))
  return [...new Set(paths)]
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

// ─── Config sync check ──────────────────────────────────────────────────────

/** Extract canonical event names from `swiz dispatch <event> ...` commands in a config. */
function extractDispatchEvents(hooks: Record<string, unknown>): Set<string> {
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

export async function checkAgentConfigSync(agent: AgentDef): Promise<CheckResult> {
  const file = Bun.file(agent.settingsPath)
  if (!(await file.exists())) {
    return {
      name: `${agent.name} config sync`,
      status: "warn",
      detail: "settings file not found — run: swiz install",
    }
  }

  let settings: Record<string, unknown>
  try {
    settings = await file.json()
  } catch {
    return {
      name: `${agent.name} config sync`,
      status: "fail",
      detail: "settings file is malformed JSON",
    }
  }

  const hooksRaw = agent.wrapsHooks
    ? ((settings.hooks as Record<string, unknown>) ?? {})
    : ((settings[agent.hooksKey] as Record<string, unknown>) ?? {})
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

/**
 * Compare skills in the working-tree plugin source against the installed cache.
 * Returns info about each local plugin whose cached copy is out of sync.
 */
async function checkPluginCacheStaleness(): Promise<PluginCacheInfo[]> {
  const results: PluginCacheInfo[] = []

  // Read installed_plugins.json to find cache paths
  const installedPath = join(HOME, ".claude", "plugins", "installed_plugins.json")
  const installedFile = Bun.file(installedPath)
  if (!(await installedFile.exists())) return results

  let installed: { version?: number; plugins?: Record<string, { installPath: string }[]> }
  try {
    installed = await installedFile.json()
  } catch {
    return results
  }

  if (!installed.plugins) return results

  // Read marketplace.json to find local plugin sources
  const marketplacePath = join(SWIZ_ROOT, ".claude-plugin", "marketplace.json")
  const marketplaceFile = Bun.file(marketplacePath)
  if (!(await marketplaceFile.exists())) return results

  let marketplace: { name?: string; plugins?: { name: string; source: string }[] }
  try {
    marketplace = await marketplaceFile.json()
  } catch {
    return results
  }

  if (!marketplace.plugins || !marketplace.name) return results

  for (const plugin of marketplace.plugins) {
    const key = `${plugin.name}@${marketplace.name}`
    const entries = installed.plugins[key]
    if (!entries || entries.length === 0) continue

    const cachePath = entries[0]!.installPath
    const sourcePath = join(SWIZ_ROOT, plugin.source)

    // Compare skills directories
    const sourceSkillsDir = join(sourcePath, "skills")
    const cacheSkillsDir = join(cachePath, "skills")

    let sourceSkills: string[]
    let cacheSkills: string[]
    try {
      const sourceEntries = await readdir(sourceSkillsDir, { withFileTypes: true })
      sourceSkills = sourceEntries
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort()
    } catch {
      continue
    }
    try {
      const cacheEntries = await readdir(cacheSkillsDir, { withFileTypes: true })
      cacheSkills = cacheEntries
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort()
    } catch {
      cacheSkills = []
    }

    const cacheSet = new Set(cacheSkills)
    const sourceSet = new Set(sourceSkills)
    const missing = sourceSkills.filter((s) => !cacheSet.has(s))
    const extra = cacheSkills.filter((s) => !sourceSet.has(s))

    // Check content staleness for skills that exist in both
    const shared = sourceSkills.filter((s) => cacheSet.has(s))
    const stale: string[] = []
    for (const skill of shared) {
      const srcFile = Bun.file(join(sourceSkillsDir, skill, "SKILL.md"))
      const cacheFile = Bun.file(join(cacheSkillsDir, skill, "SKILL.md"))
      try {
        const [srcText, cacheText] = await Promise.all([srcFile.text(), cacheFile.text()])
        if (srcText !== cacheText) stale.push(skill)
      } catch {
        // If either file is unreadable, skip content comparison
      }
    }

    if (missing.length > 0 || extra.length > 0 || stale.length > 0) {
      results.push({
        pluginName: plugin.name,
        sourcePath: sourceSkillsDir,
        cachePath: cacheSkillsDir,
        missingSkills: missing,
        extraSkills: extra,
        staleSkills: stale,
      })
    }
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

// ─── Runner ─────────────────────────────────────────────────────────────────

function printResult(result: CheckResult): void {
  const icon = result.status === "pass" ? PASS : result.status === "warn" ? WARN : FAIL
  const detailColor = result.status === "fail" ? RED : result.status === "warn" ? YELLOW : DIM
  console.log(`  ${icon} ${BOLD}${result.name}${RESET}  ${detailColor}${result.detail}${RESET}`)
}

export const doctorCommand: Command = {
  name: "doctor",
  description: "Check environment health and prerequisites",
  usage: "swiz doctor [--fix]",
  options: [
    { flags: "--fix", description: "Auto-fix stale agent configs by running swiz install" },
  ],
  async run(args) {
    const fix = args.includes("--fix")
    console.log(`\n  ${BOLD}swiz doctor${RESET}\n`)

    const results: CheckResult[] = []

    // Core runtime
    results.push(await checkBun())

    // Agent binaries and settings
    for (const agent of AGENTS) {
      results.push(checkAgentBinary(agent))
      results.push(await checkAgentSettings(agent))
    }

    // Hook scripts
    results.push(await checkHookScripts())
    results.push(await checkManifestHandlerPaths())
    const orphanedScripts = await findOrphanedHookScripts()
    results.push(buildOrphanedResult(orphanedScripts))
    results.push(await checkInstalledConfigScripts())
    results.push(await checkScriptExecutePermissions(fix))

    // Agent config sync (detect stale dispatch entries)
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

    // Plugin cache sync
    const pluginCacheInfos = await checkPluginCacheStaleness()
    results.push(...buildPluginCacheResults(pluginCacheInfos))

    // GitHub CLI
    results.push(await checkGhAuth())

    // TTS
    results.push(await checkTtsBackend())

    // Swiz settings
    results.push(await checkSwizSettings())

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

    // Auto-fix stale configs
    const staleConfigs = results.filter(
      (r) =>
        r.name.endsWith("config sync") &&
        r.status === "warn" &&
        r.detail.includes("missing dispatch")
    )
    if (fix) {
      if (staleConfigs.length > 0) {
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

      const missingConfigPaths = await findMissingConfigScriptPaths()
      if (missingConfigPaths.length > 0) {
        console.log(`  ${BOLD}Registering missing config scripts...${RESET}\n`)
        const regResult = await fixMissingConfigScripts(missingConfigPaths)
        for (const item of regResult.registered) {
          console.log(`  ${GREEN}✓${RESET} Registered stub: ${displayPath(item.path)}`)
        }
        for (const item of regResult.failed) {
          console.log(
            `  ${RED}✗${RESET} Failed to register ${displayPath(item.path)}: ${item.error}`
          )
        }
        if (regResult.registered.length > 0) console.log()
      }

      if (skillConflicts.length > 0) {
        console.log(
          `  ${YELLOW}Skill conflicts detected — resolve manually by removing duplicate skill directories.${RESET}\n`
        )
      }

      if (invalidSkillEntries.length > 0) {
        console.log(`  ${BOLD}Auto-fixing invalid skill entries...${RESET}\n`)
        const invalidResult = await fixInvalidSkillEntries(invalidSkillEntries)
        for (const item of invalidResult.generated) {
          console.log(
            `  ${GREEN}✓${RESET} ${item.name}: generated default ${displayPath(item.skillPath)}`
          )
        }
        for (const item of invalidResult.nameFixed) {
          console.log(
            `  ${GREEN}✓${RESET} ${item.name}: updated name "${item.oldName}" → "${item.name}" in ${displayPath(item.skillPath)}`
          )
        }
        for (const item of invalidResult.categoryFixed) {
          console.log(
            `  ${GREEN}✓${RESET} ${item.name}: added category "${SKILL_PLACEHOLDER_CATEGORY}" to ${displayPath(item.skillPath)}`
          )
        }
        for (const item of invalidResult.failed) {
          console.log(
            `  ${RED}✗${RESET} ${item.name}: could not fix ${displayPath(item.originalDir)} (${item.error})`
          )
        }
        if (
          invalidResult.generated.length > 0 ||
          invalidResult.nameFixed.length > 0 ||
          invalidResult.categoryFixed.length > 0
        )
          console.log()
      }

      // Restore .disabled-by-swiz-* directories (separate from invalid entry fixes)
      const disabledDirs = await findDisabledSkillDirs()
      if (disabledDirs.length > 0) {
        console.log(`  ${BOLD}Restoring disabled skill directories...${RESET}\n`)
        for (const restore of disabledDirs) {
          if (await restoreDisabledSkillDir(restore)) {
            console.log(
              `  ${GREEN}✓${RESET} ${restore.name}: restored from ${displayPath(restore.oldDir)}`
            )
          } else {
            console.log(
              `  ${RED}✗${RESET} ${restore.name}: could not restore ${displayPath(restore.oldDir)}`
            )
          }
        }
        console.log()
      }

      if (pluginCacheInfos.length > 0) {
        console.log(`  ${BOLD}Syncing plugin cache...${RESET}\n`)
        const cacheResult = await fixPluginCache(pluginCacheInfos)
        for (const skill of cacheResult.synced) {
          console.log(`  ${GREEN}✓${RESET} ${skill}: copied to plugin cache`)
        }
        for (const skill of cacheResult.updated) {
          console.log(`  ${GREEN}✓${RESET} ${skill}: updated in plugin cache`)
        }
        for (const item of cacheResult.failed) {
          console.log(`  ${RED}✗${RESET} ${item.skill}: ${item.error}`)
        }
        if (cacheResult.synced.length > 0 || cacheResult.updated.length > 0) {
          console.log(`\n  ${DIM}Restart Claude Code to pick up the changes.${RESET}`)
          console.log()
        }
      }
    } else if (
      staleConfigs.length > 0 ||
      invalidSkillEntries.length > 0 ||
      pluginCacheInfos.length > 0
    ) {
      const fixables = [
        staleConfigs.length > 0 ? "stale configs" : null,
        invalidSkillEntries.length > 0 ? "invalid skill entries" : null,
        pluginCacheInfos.length > 0 ? "stale plugin cache" : null,
      ]
        .filter(Boolean)
        .join(" and ")
      console.log(`  ${YELLOW}${fixables} detected. Run: swiz doctor --fix${RESET}\n`)
    }

    if (failures.length > 0) {
      throw new Error(
        `${failures.length} check(s) failed:\n` +
          failures.map((f) => `  - ${f.name}: ${f.detail}`).join("\n")
      )
    }
  },
}
