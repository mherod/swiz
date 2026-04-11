import { chmod, mkdir, stat } from "node:fs/promises"
import { dirname, join } from "node:path"
import { getAgentSettingsSearchPaths } from "../agent-paths.ts"
import { AGENTS, type AgentDef, CONFIGURABLE_AGENTS, translateEvent } from "../agents.ts"
import { debugLog, stderrLog } from "../debug.ts"
import { getHomeDirWithFallback } from "../home.ts"
import { isInlineHookDef, manifest } from "../manifest.ts"
import { readProjectSettings, readSwizSettings } from "../settings.ts"
import type { Command } from "../types.ts"
import { isDaemonReady } from "./daemon/daemon-admin.ts"
import { runDoctorChecks } from "./doctor/check-runner.ts"
import { DIAGNOSTIC_CHECKS } from "./doctor/checks"
import { autoCleanup, runCleanupCommand } from "./doctor/cleanup.ts"
import {
  buildInvalidSkillResults,
  buildPluginCacheResults,
  buildSkillConflictResults,
  checkPluginCacheStaleness,
  displayPath,
  findInvalidSkillEntries,
  findSkillConflicts,
  fixInvalidSkillEntries,
  fixSkillConflicts,
  fixStalePluginCache,
  type InvalidSkillEntry,
  type PluginCacheInfo,
  SKILL_PLACEHOLDER_CATEGORY,
  type SkillConflict,
} from "./doctor/fix.ts"
import type { CheckResult, DiagnosticCheck } from "./doctor/types.ts"
import { whichExists } from "./doctor/utils.ts"

export { truncateJsonlFile } from "./doctor/cleanup.ts"
export {
  type CleanupArgs,
  decodeProjectPath,
  parseCleanupArgs,
  walkDecode,
} from "./doctor/cleanup-path.ts"

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
import { messageFromUnknownError } from "../utils/hook-json-helpers.ts"

const HOME = getHomeDirWithFallback("")

const DOCTOR_CHECK_TIMEOUT_MS = 60_000
const AUTO_CLEANUP_TIMEOUT_MS = 75_000

class DoctorTimeoutError extends Error {
  constructor(label: string, timeoutMs: number) {
    super(`${label} timed out after ${timeoutMs}ms`)
    this.name = "DoctorTimeoutError"
  }
}

async function runWithTimeout<T>(
  label: string,
  timeoutMs: number,
  task: () => Promise<T>
): Promise<T> {
  const start = Date.now()
  debugLog("doctor", `Starting ${label} (timeout ${timeoutMs}ms)`)
  let timerId: ReturnType<typeof setTimeout> | undefined
  try {
    const timerPromise = new Promise<never>((_, reject) => {
      timerId = setTimeout(() => reject(new DoctorTimeoutError(label, timeoutMs)), timeoutMs)
    })
    const taskPromise = task()
    return await Promise.race([taskPromise, timerPromise])
  } finally {
    if (timerId) clearTimeout(timerId)
    const elapsed = Date.now() - start
    debugLog("doctor", `${label} finished after ${elapsed}ms`)
  }
}

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
      failed.push({ path: p, error: messageFromUnknownError(err) })
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
    const msg = messageFromUnknownError(e)
    return {
      name: "Swiz settings",
      status: "fail",
      detail: msg,
    }
  }
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
function extractDispatchEvents(hooks: Record<string, unknown>): Set<string> {
  const events = new Set<string>()
  const dispatchRe = /swiz dispatch (\S+)/
  for (const cmd of collectCommandStrings(hooks)) {
    const m = dispatchRe.exec(cmd)
    if (m?.[1]) events.add(m[1])
  }
  return events
}

/** Get the set of canonical events the manifest expects to be dispatched via agent configs.
 *  Scheduled events (preCommit, commitMsg, prePush) are dispatched via lefthook,
 *  not agent settings — exclude them to match what `swiz install` actually writes. */
function getExpectedCanonicalEvents(): Set<string> {
  const events = new Set<string>()
  for (const group of manifest) {
    if (group.scheduled) continue
    events.add(group.event)
  }
  return events
}

/** Outcome of reading and parsing an agent settings JSON file for config-sync checks. */
type AgentSettingsLoadResult =
  | { ok: true; settings: Record<string, unknown> }
  | { ok: false; diagnostic: CheckResult }

async function loadAgentSettings(agent: AgentDef): Promise<AgentSettingsLoadResult> {
  const file = Bun.file(agent.settingsPath)
  if (!(await file.exists())) {
    return {
      ok: false,
      diagnostic: {
        name: `${agent.name} config sync`,
        status: "warn",
        detail: "settings file not found — run: swiz install",
      },
    }
  }
  try {
    const parsed: unknown = await file.json()
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        ok: false,
        diagnostic: {
          name: `${agent.name} config sync`,
          status: "fail",
          detail: "settings file root must be a JSON object",
        },
      }
    }
    return { ok: true, settings: parsed as Record<string, unknown> }
  } catch {
    return {
      ok: false,
      diagnostic: {
        name: `${agent.name} config sync`,
        status: "fail",
        detail: "settings file is malformed JSON",
      },
    }
  }
}

export async function checkAgentConfigSync(agent: AgentDef): Promise<CheckResult> {
  const loaded = await loadAgentSettings(agent)
  if (!loaded.ok) return loaded.diagnostic
  const { settings } = loaded

  const hooksRaw = agent.wrapsHooks
    ? ((settings.hooks as Record<string, unknown> | undefined) ?? {})
    : ((settings[agent.hooksKey] as Record<string, unknown> | undefined) ?? {})
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

// ─── Auto-fix logic ─────────────────────────────────────────────────────────

interface AutoFixContext {
  fix: boolean
  results: CheckResult[]
  skillConflicts: SkillConflict[]
  invalidSkillEntries: InvalidSkillEntry[]
  pluginCacheInfos: PluginCacheInfo[]
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

async function handleAutoFixes(ctx: AutoFixContext): Promise<void> {
  const { fix, results, skillConflicts, invalidSkillEntries, pluginCacheInfos } = ctx
  const hasStaleConfigs = results.some(
    (r) =>
      r.name.endsWith("config sync") && r.status === "warn" && r.detail.includes("missing dispatch")
  )
  if (fix) {
    await fixStaleConfigs(results)
    await fixMissingConfigs()
    const skillConflictMessages = await fixSkillConflicts(skillConflicts, fix)
    if (skillConflictMessages.length > 0) {
      console.log(`  ${BOLD}Skill conflicts detected${RESET}. Removing overridden versions...\n`)
      for (const message of skillConflictMessages) {
        console.log(`  ${GREEN}✓${RESET} ${message}`)
      }
      console.log()
    }
    await fixInvalidSkills(invalidSkillEntries)
    const pluginCacheMessages = await fixStalePluginCache(pluginCacheInfos)
    if (pluginCacheMessages.length > 0) {
      console.log(`  ${BOLD}Syncing plugin cache...${RESET}\n`)
      for (const message of pluginCacheMessages) {
        if (message.startsWith("Restart ")) {
          console.log(`  ${DIM}${message}${RESET}`)
        } else if (message.includes(": copied") || message.includes(": updated")) {
          console.log(`  ${GREEN}✓${RESET} ${message}`)
        } else {
          console.log(`  ${RED}✗${RESET} ${message}`)
        }
      }
      console.log()
    }
    try {
      await runWithTimeout("auto-cleanup", AUTO_CLEANUP_TIMEOUT_MS, autoCleanup)
    } catch (err) {
      const message =
        err instanceof DoctorTimeoutError
          ? `  ${YELLOW}Warning: auto-cleanup timed out after ${AUTO_CLEANUP_TIMEOUT_MS}ms${RESET}`
          : `  ${YELLOW}Warning: auto-cleanup failed: ${err}${RESET}`
      stderrLog("auto-cleanup", message)
    }
    return
  }
  if (hasStaleConfigs || invalidSkillEntries.length > 0 || pluginCacheInfos.length > 0) {
    const fixables = [
      hasStaleConfigs ? "stale configs" : null,
      invalidSkillEntries.length > 0 ? "invalid skill entries" : null,
      pluginCacheInfos.length > 0 ? "stale plugin cache" : null,
    ]
      .filter(Boolean)
      .join(" and ")
    console.log(`  ${YELLOW}${fixables} detected. Run: swiz doctor --fix${RESET}\n`)
  }
}

// ─── Registered diagnostic checks ───────────────────────────────────────────

export const agentBinaryAndSettingsCheck: DiagnosticCheck = {
  name: "agent-binary-and-settings",
  async run() {
    const results: CheckResult[] = []
    for (const agent of AGENTS) {
      results.push(await checkAgentBinary(agent))
      results.push(await checkAgentSettings(agent))
    }
    return results
  },
}

export const hookScriptsCheck: DiagnosticCheck = {
  name: "hook-scripts",
  run: () => checkHookScripts().then((r) => [r]),
}

export const manifestPathsCheck: DiagnosticCheck = {
  name: "manifest-paths",
  run: () => checkManifestHandlerPaths().then((r) => [r]),
}

export const configScriptsCheck: DiagnosticCheck = {
  name: "config-scripts",
  run: () => checkInstalledConfigScripts().then((r) => [r]),
}

export const scriptPermissionsCheck: DiagnosticCheck = {
  name: "script-permissions",
  run: (ctx) => checkScriptExecutePermissions(ctx.fix).then((r) => [r]),
}

export const agentConfigSyncCheck: DiagnosticCheck = {
  name: "agent-config-sync",
  async run() {
    const results: CheckResult[] = []
    for (const agent of CONFIGURABLE_AGENTS) {
      results.push(await checkAgentConfigSync(agent))
    }
    return results
  },
}

export const skillConflictsCheck: DiagnosticCheck = {
  name: "skill-conflicts",
  async run(ctx) {
    const conflicts = await findSkillConflicts()
    ctx.store.skillConflicts = conflicts
    return buildSkillConflictResults(conflicts)
  },
}

export const invalidSkillEntriesCheck: DiagnosticCheck = {
  name: "invalid-skill-entries",
  async run(ctx) {
    const projectSettings = await readProjectSettings(process.cwd())
    const allowedCategories = new Set(
      projectSettings?.allowedSkillCategories ?? DEFAULT_ALLOWED_SKILL_CATEGORIES
    )
    const entries = await findInvalidSkillEntries(allowedCategories)
    ctx.store.invalidSkillEntries = entries
    return buildInvalidSkillResults(entries)
  },
}

export const pluginCacheCheck: DiagnosticCheck = {
  name: "plugin-cache",
  async run(ctx) {
    const infos = await checkPluginCacheStaleness()
    ctx.store.pluginCacheInfos = infos
    return buildPluginCacheResults(infos)
  },
}

export const swizSettingsCheck: DiagnosticCheck = {
  name: "swiz-settings",
  run: () => checkSwizSettings().then((r) => [r]),
}

/** All checks including registry and inline. Order determines display order. */
const ALL_CHECKS: DiagnosticCheck[] = [
  ...DIAGNOSTIC_CHECKS,
  agentBinaryAndSettingsCheck,
  hookScriptsCheck,
  manifestPathsCheck,
  configScriptsCheck,
  scriptPermissionsCheck,
  agentConfigSyncCheck,
  skillConflictsCheck,
  invalidSkillEntriesCheck,
  pluginCacheCheck,
  swizSettingsCheck,
]

/** Best-effort daemon notification after fixing issues (similar to settings write). */
async function notifyDaemon(jsonOutput: boolean): Promise<void> {
  if (await isDaemonReady()) {
    if (!jsonOutput) console.log("  Daemon notified of changes.")
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── Command ────────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

export const doctorCommand: Command = {
  name: "doctor",
  description: "Check environment health, fix issues, and clean up old session data",
  usage: "swiz doctor [--fix] | swiz doctor clean [--older-than <time>] [--dry-run]",
  options: [
    { flags: "--fix", description: "Auto-fix stale agent configs by running swiz install" },
    {
      flags: "clean",
      description: "Remove old Claude Code/Junie session data and Gemini backup artifacts",
    },
    { flags: "--older-than <time>", description: "Cleanup window (e.g. 30, 7d, 48h)" },
    { flags: "--task-older-than <time>", description: "Separate window for task files" },
    { flags: "--project <name>", description: "Filter by project name or path" },
    { flags: "--dry-run", description: "Show what would be removed without trashing" },
    {
      flags: "--skip-trash",
      description: "Hard delete instead of moving to Trash (skips .bak backups)",
    },
    { flags: "--junie-only", description: "Only scan Junie sessions" },
  ],
  async run(args) {
    if (args[0] === "clean") {
      await runCleanupCommand(args.slice(1))
      return
    }
    await runWithTimeout("diagnostic checks", DOCTOR_CHECK_TIMEOUT_MS, () =>
      runDoctorChecks(args, {
        allChecks: ALL_CHECKS,
        handleAutoFixes,
        notifyDaemon,
      })
    )
  },
}
