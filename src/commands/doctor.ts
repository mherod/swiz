import { chmod, rename, stat } from "node:fs/promises"
import { dirname, join } from "node:path"
import { AGENTS, type AgentDef, CONFIGURABLE_AGENTS, translateEvent } from "../agents.ts"
import { manifest } from "../manifest.ts"
import { readSwizSettings } from "../settings.ts"
import { findSkillConflicts, SKILL_PRECEDENCE, type SkillConflict } from "../skill-utils.ts"
import type { Command } from "../types.ts"

const SWIZ_ROOT = dirname(Bun.main)
const HOOKS_DIR = join(SWIZ_ROOT, "hooks")

const BOLD = "\x1b[1m"
const GREEN = "\x1b[32m"
const RED = "\x1b[31m"
const YELLOW = "\x1b[33m"
const DIM = "\x1b[2m"
const RESET = "\x1b[0m"
const HOME = process.env.HOME ?? ""

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

/** Find .ts files in hooks/ that are not referenced by any manifest entry. */
async function checkOrphanedHookScripts(): Promise<CheckResult> {
  const manifestFiles = new Set(manifest.flatMap((g) => g.hooks.map((h) => h.file)))

  const glob = new Bun.Glob("*.ts")
  const orphaned: string[] = []
  for await (const file of glob.scan({ cwd: HOOKS_DIR })) {
    // Skip test files — they are not hook scripts
    if (file.endsWith(".test.ts")) continue
    if (manifestFiles.has(file)) continue
    // Only flag hook entry points (files with a bun shebang on the first line).
    // Library files imported by hooks (e.g. hook-utils.ts) have no shebang and are not hook scripts.
    // Read the first 256 bytes and extract the first line to avoid loading full file contents.
    const chunk = await Bun.file(join(HOOKS_DIR, file)).slice(0, 256).text()
    const firstLine = chunk.split("\n", 1)[0] ?? ""
    if (!firstLine.startsWith("#!/") || !firstLine.includes("bun")) continue
    orphaned.push(file)
  }

  orphaned.sort()

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
    detail: `${orphaned.length} script(s) in hooks/ not referenced by manifest: ${orphaned.join(", ")}`,
  }
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

interface SkillConflictFixSuccess {
  name: string
  originalDir: string
  movedDir: string
}

interface SkillConflictFixFailure {
  name: string
  originalDir: string
  error: string
}

function conflictSuffixTimestamp(): string {
  const d = new Date()
  const yyyy = d.getFullYear().toString().padStart(4, "0")
  const mm = (d.getMonth() + 1).toString().padStart(2, "0")
  const dd = d.getDate().toString().padStart(2, "0")
  const hh = d.getHours().toString().padStart(2, "0")
  const min = d.getMinutes().toString().padStart(2, "0")
  const ss = d.getSeconds().toString().padStart(2, "0")
  return `${yyyy}${mm}${dd}${hh}${min}${ss}`
}

async function nextConflictBackupDir(originalDir: string, stamp: string): Promise<string> {
  let attempt = 0
  while (true) {
    const suffix = attempt === 0 ? stamp : `${stamp}-${attempt}`
    const candidate = `${originalDir}.disabled-by-swiz-${suffix}`
    if (!(await Bun.file(candidate).exists())) {
      return candidate
    }
    attempt++
  }
}

async function fixSkillConflicts(
  conflicts: SkillConflict[]
): Promise<{ fixed: SkillConflictFixSuccess[]; failed: SkillConflictFixFailure[] }> {
  const fixed: SkillConflictFixSuccess[] = []
  const failed: SkillConflictFixFailure[] = []
  const stamp = conflictSuffixTimestamp()

  for (const conflict of conflicts) {
    for (const entry of conflict.overridden) {
      const originalDir = dirname(entry.path)
      const movedDir = await nextConflictBackupDir(originalDir, stamp)
      try {
        await rename(originalDir, movedDir)
        fixed.push({ name: conflict.name, originalDir, movedDir })
      } catch (err: unknown) {
        failed.push({
          name: conflict.name,
          originalDir,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  return { fixed, failed }
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
  const paths = await collectExecutableScriptPaths()
  const missing: string[] = []
  const notExecutable: string[] = []

  for (const scriptPath of paths) {
    if (!(await Bun.file(scriptPath).exists())) {
      missing.push(scriptPath)
      continue
    }
    try {
      const s = await stat(scriptPath)
      if ((s.mode & 0o100) === 0) {
        notExecutable.push(scriptPath)
      }
    } catch {
      // stat failure treated as missing
      missing.push(scriptPath)
    }
  }

  if (missing.length === 0 && notExecutable.length === 0) {
    return {
      name: "Installed config scripts",
      status: "pass",
      detail: `all ${paths.length} executable scripts are present and executable`,
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
    results.push(await checkOrphanedHookScripts())
    results.push(await checkInstalledConfigScripts())
    results.push(await checkScriptExecutePermissions(fix))

    // Agent config sync (detect stale dispatch entries)
    for (const agent of CONFIGURABLE_AGENTS) {
      results.push(await checkAgentConfigSync(agent))
    }

    const skillConflicts = await findSkillConflicts()
    results.push(...buildSkillConflictResults(skillConflicts))

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

      if (skillConflicts.length > 0) {
        console.log(`  ${BOLD}Auto-fixing skill conflicts...${RESET}\n`)
        const fixedResult = await fixSkillConflicts(skillConflicts)
        for (const item of fixedResult.fixed) {
          console.log(
            `  ${GREEN}✓${RESET} ${item.name}: moved ${displayPath(item.originalDir)} -> ${displayPath(item.movedDir)}`
          )
          console.log(
            `    ${DIM}restore: mv "${displayPath(item.movedDir)}" "${displayPath(item.originalDir)}"${RESET}`
          )
        }
        for (const item of fixedResult.failed) {
          console.log(
            `  ${RED}✗${RESET} ${item.name}: could not move ${displayPath(item.originalDir)} (${item.error})`
          )
        }
        if (fixedResult.fixed.length > 0) {
          console.log()
        }
      }
    } else if (staleConfigs.length > 0 || skillConflicts.length > 0) {
      const fixables = [
        staleConfigs.length > 0 ? "stale configs" : null,
        skillConflicts.length > 0 ? "skill conflicts" : null,
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
