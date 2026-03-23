import { dirname, join } from "node:path"
import { stderrLog } from "../debug.ts"
import { detectProjectStack } from "../detect-frameworks.ts"
import {
  DEFAULT_MEMORY_LINE_THRESHOLD,
  DEFAULT_MEMORY_WORD_THRESHOLD,
  type EffectiveSwizSettings,
  getEffectiveSwizSettings,
  getProjectSettingsPath,
  getSwizSettingsPath,
  type ProjectSwizSettings,
  readProjectSettings,
  readSwizSettings,
  resolveMemoryThresholds,
  resolvePolicy,
  SETTINGS_REGISTRY,
  type SettingDef,
  type SettingsScope,
  type SwizSettings,
  settingsStore,
} from "../settings.ts"
import { spawnSpeak } from "../speech.ts"
import { findAllProviderSessions } from "../transcript-utils.ts"
import type { Command } from "../types.ts"

type Action = "show" | "enable" | "disable" | "set" | "disable-hook" | "enable-hook"

// ── Derived lookups (built once from the registry) ────────────────────────

/** Alias → canonical key lookup. */
const ALIAS_MAP = new Map<string, string>()
for (const def of SETTINGS_REGISTRY) {
  for (const alias of def.aliases) ALIAS_MAP.set(alias, def.key)
}

/** Canonical key → definition lookup. */
const DEF_BY_KEY = new Map<string, SettingDef>()
for (const def of SETTINGS_REGISTRY) DEF_BY_KEY.set(def.key, def)

// ── Type aliases (kept for external consumers / printSettings signature) ──

type SettingKey = string & { readonly __brand?: "SettingKey" }

interface ParsedSettingsArgs {
  action: Action
  settingArg?: string
  settingValue?: string
  targetDir: string
  scope: SettingsScope
  sessionQuery: string | null
  force: boolean
}

function validateSettingScope(key: SettingKey, scope: SettingsScope, settingArg: string): void {
  const def = getSettingDef(key)
  if (!def.scopes.includes(scope)) {
    const scopeList = def.scopes.join(", ")
    throw new Error(
      `"${settingArg}" does not support --${scope} scope. Supported: ${scopeList}\n${usage()}`
    )
  }
}

function primaryAlias(def: SettingDef): string {
  return def.aliases[0] ?? def.key
}

function aliasesForScope(scope: SettingsScope): string {
  return SETTINGS_REGISTRY.filter((def) => def.scopes.includes(scope))
    .map(primaryAlias)
    .join(", ")
}

function usage(): string {
  return (
    "Usage: swiz settings [show | enable <setting> | disable <setting> | set <setting> <value> | disable-hook <filename> | enable-hook <filename>] [--global | --project | --session [id]] [--dir <path>] [--force]\n" +
    "Scope: --global (default, ~/.swiz/settings.json), --project (.swiz/config.json), --session [id] (per-session)\n" +
    `Settings (--global): ${aliasesForScope("global")}\n` +
    `Settings (--project): ${aliasesForScope("project")}\n` +
    `Settings (--session): ${aliasesForScope("session")}\n` +
    "Hook management: disable-hook <filename> (e.g. stop-github-ci.ts), enable-hook <filename>"
  )
}

function parseSetting(raw: string | undefined): SettingKey {
  if (!raw) throw new Error(`Missing setting name.\n${usage()}`)
  const normalized = raw.trim().toLowerCase()
  const key = ALIAS_MAP.get(normalized)
  if (key) return key as SettingKey
  throw new Error(`Unknown setting: ${raw}\n${usage()}`)
}

function getSettingDef(key: SettingKey): SettingDef {
  const def = DEF_BY_KEY.get(key)
  if (!def) throw new Error(`No registry entry for setting: ${key}`)
  return def
}

function isNumericSetting(key: SettingKey): boolean {
  return getSettingDef(key).kind === "numeric"
}

function isStringSetting(key: SettingKey): boolean {
  return getSettingDef(key).kind === "string"
}

const SCOPE_FLAGS: Record<string, SettingsScope> = {
  "--global": "global",
  "-g": "global",
  "--project": "project",
  "-p": "project",
  "--session": "session",
  "-s": "session",
}

const VALID_ACTIONS = new Set(["show", "enable", "disable", "set", "disable-hook", "enable-hook"])

interface SettingsArgState {
  positionals: string[]
  targetDir: string
  scope: SettingsScope
  sessionQuery: string | null
  force: boolean
}

function processSettingsArg(args: string[], i: number, state: SettingsArgState): number {
  const arg = args[i]!
  const next = args[i + 1]

  if (arg === "--force" || arg === "-f") {
    state.force = true
    return i
  }

  if (arg === "--dir" || arg === "-d") {
    if (!next || next.startsWith("-")) throw new Error(`Missing value for ${arg}.\n${usage()}`)
    state.targetDir = next
    return i + 1
  }

  const scopeValue = SCOPE_FLAGS[arg]
  if (scopeValue) {
    state.scope = scopeValue
    if (scopeValue === "session" && next && !next.startsWith("-")) {
      state.sessionQuery = next
      return i + 1
    }
    return i
  }

  state.positionals.push(arg)
  return i
}

function parseSettingsArgs(args: string[]): ParsedSettingsArgs {
  const state: SettingsArgState = {
    positionals: [],
    targetDir: process.cwd(),
    scope: "global",
    sessionQuery: null,
    force: false,
  }

  for (let i = 0; i < args.length; i++) {
    if (!args[i]) continue
    i = processSettingsArg(args, i, state)
  }

  const rawAction = (state.positionals[0] ?? "show").toLowerCase()
  if (!VALID_ACTIONS.has(rawAction)) {
    throw new Error(`Unknown subcommand: ${state.positionals[0]}\n${usage()}`)
  }

  return {
    action: rawAction as Action,
    settingArg: state.positionals[1],
    settingValue: state.positionals[2],
    targetDir: state.targetDir,
    scope: state.scope,
    sessionQuery: state.sessionQuery,
    force: state.force,
  }
}

async function resolveSessionId(query: string | null, targetDir: string): Promise<string> {
  const sessions = await findAllProviderSessions(targetDir)

  if (sessions.length === 0) {
    throw new Error(`No sessions found for: ${targetDir}\n(checked all configured providers)`)
  }

  if (!query) return sessions[0]!.id

  const match = sessions.find((s) => s.id.startsWith(query))
  if (match) return match.id

  const available = sessions.map((s) => `  ${s.id}`).join("\n")
  throw new Error(`No session matching: ${query}\nAvailable sessions:\n${available}`)
}

interface ProjectPolicyInfo {
  configPath: string
  profile: string | null
  trivialMaxFiles: number
  trivialMaxLines: number
  defaultBranch: string
  defaultBranchSource: "project" | "auto"
  memoryLineThreshold: number
  memoryLineSource: "project" | "user" | "default"
  memoryWordThreshold: number
  memoryWordSource: "project" | "user" | "default"
  source: "project" | "default"
  disabledHooks?: string[]
}

interface PrintSettingsOptions {
  effective: EffectiveSwizSettings & { disabledHooks?: string[] }
  path: string | null
  fileExists: boolean
  sessionId: string | null
  ambitionSource?: "global" | "project" | "session"
  strictNoDirectMainSource?: "global" | "project"
  projectPolicyInfo?: ProjectPolicyInfo
  detectedStacks?: string[]
}

function printHeader(path: string | null, fileExists: boolean, sessionId: string | null): void {
  console.log("\n  swiz settings\n")
  if (!path) {
    console.log("  config: unavailable (HOME not set)")
  } else {
    const sourceLabel = fileExists ? "custom" : "defaults"
    console.log(`  config: ${path} (${sourceLabel})`)
  }
  if (sessionId) console.log(`  scope: session ${sessionId}`)
}

type BoolSettingRow = [label: string, key: keyof EffectiveSwizSettings, scope: string]

function resolveScopeLabel(source: string | undefined, fallback: string): string {
  if (source === "session") return "session override"
  if (source === "project") return "project override"
  return fallback
}

function printBooleanSettings(rows: BoolSettingRow[], effective: EffectiveSwizSettings): void {
  for (const [label, key, scope] of rows) {
    const value = effective[key] ? "enabled" : "disabled"
    console.log(`  ${label} ${value} (${scope})`)
  }
}

const GLOBAL_BOOL_ROWS: BoolSettingRow[] = [
  ["critiques:      ", "critiquesEnabled", "global"],
  ["pr-merge-mode:  ", "prMergeMode", "global"],
  ["push-gate:      ", "pushGate", "global"],
  ["sandboxed-edits:", "sandboxedEdits", "global"],
  ["speak:          ", "speak", "global"],
  ["update-memory-footer:", "updateMemoryFooter", "global"],
  ["git-status-gate:        ", "gitStatusGate", "global"],
  ["non-default-branch-gate:", "nonDefaultBranchGate", "global"],
  ["github-ci-gate:         ", "githubCiGate", "global"],
  ["changes-requested-gate: ", "changesRequestedGate", "global"],
  ["personal-repo-issues-gate:", "personalRepoIssuesGate", "global"],
  ["issue-close-gate:         ", "issueCloseGate", "global"],
  ["quality-checks-gate:      ", "qualityChecksGate", "global"],
]

function printGlobalSettings(
  effective: EffectiveSwizSettings & { disabledHooks?: string[] },
  ambitionSource: "global" | "project" | "session" | undefined,
  strictNoDirectMainSource: "global" | "project" | undefined
): void {
  const scopeLabel = effective.source === "session" ? "session override" : "global/default"
  const ambitionScopeLabel = resolveScopeLabel(ambitionSource, "global/default")
  const strictLabel = strictNoDirectMainSource === "project" ? "project override" : "global"

  console.log(
    `  auto-continue:   ${effective.autoContinue ? "enabled" : "disabled"} (${scopeLabel})`
  )
  console.log(`  ambition-mode:   ${effective.ambitionMode} (${ambitionScopeLabel})`)
  console.log(
    `  collaboration:   ${effective.collaborationMode} (${effective.collaborationMode === "auto" ? "default" : scopeLabel})`
  )

  printBooleanSettings(GLOBAL_BOOL_ROWS, effective)

  console.log(
    `  strict-no-direct-main:   ${effective.strictNoDirectMain ? "enabled" : "disabled"} (${strictLabel})`
  )

  const ageGateLabel =
    effective.prAgeGateMinutes > 0 ? `${effective.prAgeGateMinutes} minutes` : "disabled"
  const cooldownLabel =
    effective.pushCooldownMinutes > 0 ? `${effective.pushCooldownMinutes} minutes` : "disabled"
  console.log(`  pr-age-gate:     ${ageGateLabel} (global)`)
  console.log(`  push-cooldown:   ${cooldownLabel} (global)`)
  console.log(`  narrator-voice:  ${effective.narratorVoice || "system default"} (global)`)
  console.log(
    `  narrator-speed:  ${effective.narratorSpeed > 0 ? `${effective.narratorSpeed} wpm` : "system default"} (global)`
  )
  console.log(`  memory-line-threshold: ${effective.memoryLineThreshold} (global)`)
  console.log(`  memory-word-threshold: ${effective.memoryWordThreshold} (global)`)
  console.log(`  large-file-size-kb: ${effective.largeFileSizeKb} (global)`)

  const globalDisabled = effective.disabledHooks ?? []
  if (globalDisabled.length > 0) {
    console.log(`  disabled-hooks:  ${globalDisabled.join(", ")} (global)`)
  }
}

function printProjectPolicy(projectPolicyInfo: ProjectPolicyInfo, detectedStacks?: string[]): void {
  console.log("\n  project policy")
  console.log(`  config: ${projectPolicyInfo.configPath} (${projectPolicyInfo.source})`)
  const profileLabel = projectPolicyInfo.profile ?? "none"
  console.log(`  profile:         ${profileLabel} (${projectPolicyInfo.source})`)
  console.log(
    `  trivial-max-files: ${projectPolicyInfo.trivialMaxFiles} (${projectPolicyInfo.source})`
  )
  console.log(
    `  trivial-max-lines: ${projectPolicyInfo.trivialMaxLines} (${projectPolicyInfo.source})`
  )
  console.log(
    `  default-branch: ${projectPolicyInfo.defaultBranch} (${projectPolicyInfo.defaultBranchSource})`
  )
  console.log(
    `  memory-line-threshold: ${projectPolicyInfo.memoryLineThreshold} (${projectPolicyInfo.memoryLineSource})`
  )
  console.log(
    `  memory-word-threshold: ${projectPolicyInfo.memoryWordThreshold} (${projectPolicyInfo.memoryWordSource})`
  )
  const projectDisabled = projectPolicyInfo.disabledHooks ?? []
  if (projectDisabled.length > 0) {
    console.log(`  disabled-hooks:  ${projectDisabled.join(", ")} (project)`)
  }
  if (detectedStacks !== undefined) {
    const stacksLabel = detectedStacks.length > 0 ? detectedStacks.join(", ") : "none detected"
    console.log(`  detected-stacks: ${stacksLabel}`)
  }
}

function printSettings(opts: PrintSettingsOptions): void {
  printHeader(opts.path, opts.fileExists, opts.sessionId)
  printGlobalSettings(opts.effective, opts.ambitionSource, opts.strictNoDirectMainSource)
  if (opts.projectPolicyInfo) {
    printProjectPolicy(opts.projectPolicyInfo, opts.detectedStacks)
  }
  console.log("")
}

function resolveAmbitionSource(
  sessionId: string | null,
  settings: SwizSettings,
  projectSettings: ProjectSwizSettings | null
): "global" | "project" | "session" {
  if (sessionId && settings.sessions[sessionId]?.ambitionMode) return "session"
  if (projectSettings?.ambitionMode) return "project"
  return "global"
}

function buildProjectPolicyInfo(
  targetDir: string,
  settings: SwizSettings,
  projectSettings: ProjectSwizSettings | null
): ProjectPolicyInfo {
  const policy = resolvePolicy(projectSettings)
  const memoryThresholds = resolveMemoryThresholds(
    projectSettings,
    {
      memoryLineThreshold: settings.memoryLineThreshold,
      memoryWordThreshold: settings.memoryWordThreshold,
    },
    {
      memoryLineThreshold: DEFAULT_MEMORY_LINE_THRESHOLD,
      memoryWordThreshold: DEFAULT_MEMORY_WORD_THRESHOLD,
    }
  )
  return {
    configPath: getProjectSettingsPath(targetDir),
    profile: policy.profile,
    trivialMaxFiles: policy.trivialMaxFiles,
    trivialMaxLines: policy.trivialMaxLines,
    defaultBranch: projectSettings?.defaultBranch ?? "auto-detect",
    defaultBranchSource: projectSettings?.defaultBranch ? ("project" as const) : ("auto" as const),
    memoryLineThreshold: memoryThresholds.memoryLineThreshold,
    memoryLineSource: memoryThresholds.memoryLineSource,
    memoryWordThreshold: memoryThresholds.memoryWordThreshold,
    memoryWordSource: memoryThresholds.memoryWordSource,
    source: policy.source,
    disabledHooks: projectSettings?.disabledHooks,
  }
}

async function showSettings(parsed: ParsedSettingsArgs): Promise<void> {
  const sessionId =
    parsed.scope === "session"
      ? await resolveSessionId(parsed.sessionQuery, parsed.targetDir)
      : null
  const settings = await readSwizSettings({ strict: true })
  const projectSettings = await readProjectSettings(parsed.targetDir)
  const effective = getEffectiveSwizSettings(settings, sessionId, projectSettings)
  const path = getSwizSettingsPath()
  const fileExists = path ? await Bun.file(path).exists() : false

  const detectedStacks = await detectProjectStack(parsed.targetDir)
  printSettings({
    effective: { ...effective, disabledHooks: settings.disabledHooks },
    path,
    fileExists,
    sessionId,
    ambitionSource: resolveAmbitionSource(sessionId, settings, projectSettings),
    strictNoDirectMainSource:
      projectSettings?.strictNoDirectMain !== undefined ? "project" : "global",
    projectPolicyInfo: buildProjectPolicyInfo(parsed.targetDir, settings, projectSettings),
    detectedStacks,
  })
}

/**
 * Detect settings that conflict with enabling strictNoDirectMain.
 * Returns a list of human-readable conflict descriptions, or [] if none.
 */
async function detectStrictNoDirectMainConflicts(targetDir: string): Promise<string[]> {
  const settings = await readSwizSettings()
  const projectSettings = await readProjectSettings(targetDir)
  const conflicts: string[] = []

  if (settings.collaborationMode === "solo") {
    conflicts.push(
      `collaborationMode=solo (relaxes branch protection to solo workflow; ` +
        `set it to "auto" or "team" first, or use --force to override)`
    )
  }
  if (!settings.nonDefaultBranchGate) {
    conflicts.push(
      `nonDefaultBranchGate=false (disables branch gate enforcement; ` +
        `re-enable it with: swiz settings enable non-default-branch-gate)`
    )
  }
  if (!settings.pushGate) {
    conflicts.push(
      `pushGate=false (push gate is disabled; ` + `enable it with: swiz settings enable push-gate)`
    )
  }
  if (projectSettings?.profile === "solo") {
    conflicts.push(
      `project profile=solo (relaxes trivial-change thresholds; ` +
        `remove or change the profile in .swiz/config.json)`
    )
  }
  return conflicts
}

async function enforceStrictNoDirectMainConflicts(parsed: ParsedSettingsArgs): Promise<void> {
  const conflicts = await detectStrictNoDirectMainConflicts(parsed.targetDir)
  if (conflicts.length === 0) return
  if (!parsed.force) {
    const conflictList = conflicts.map((c) => `  - ${c}`).join("\n")
    throw new Error(
      `Cannot enable strict-no-direct-main: conflicting settings detected:\n\n${conflictList}\n\n` +
        `Resolve the conflicts above, or use --force to override:\n` +
        `  swiz settings enable strict-no-direct-main --force\n`
    )
  }
  stderrLog(
    "settings enable --force prints a warning about conflicting settings",
    `\n  Warning: enabling strict-no-direct-main with conflicting settings (--force):\n` +
      conflicts.map((c) => `    - ${c}`).join("\n") +
      `\n`
  )
}

async function setBooleanSetting(enabled: boolean, parsed: ParsedSettingsArgs): Promise<void> {
  const key = parseSetting(parsed.settingArg)
  if (isNumericSetting(key) || isStringSetting(key)) {
    throw new Error(
      `"${parsed.settingArg}" is not a boolean setting. Use: swiz settings set ${parsed.settingArg} <value>\n${usage()}`
    )
  }
  validateSettingScope(key, parsed.scope, parsed.settingArg ?? key)

  if (key === "strictNoDirectMain" && enabled) {
    await enforceStrictNoDirectMainConflicts(parsed)
  }

  const path = await writeSettingToScope(parsed, key, enabled)
  const verb = enabled ? "Enabled" : "Disabled"
  let scopeLabel = parsed.scope as string
  if (parsed.scope === "session") {
    const sessionId = await resolveSessionId(parsed.sessionQuery, parsed.targetDir)
    scopeLabel = `session ${sessionId}`
  }
  console.log(`\n  ${verb} ${parsed.settingArg ?? key} (${scopeLabel})`)
  console.log(`  Saved: ${path}\n`)

  if (enabled && key === "speak") {
    const updatedSettings = await readSwizSettings()
    const speakScriptPath = join(dirname(Bun.main), "hooks", "speak.ts")
    await spawnSpeak("TTS enabled", updatedSettings, speakScriptPath)
  }
}

async function setValueSetting(parsed: ParsedSettingsArgs): Promise<void> {
  const key = parseSetting(parsed.settingArg)
  if (!parsed.settingValue) {
    throw new Error(
      `Missing value. Usage: swiz settings set ${parsed.settingArg} <value>\n${usage()}`
    )
  }
  validateSettingScope(key, parsed.scope, parsed.settingArg ?? key)

  const def = getSettingDef(key)

  if (def.kind === "string") {
    if (def.validate) {
      const error = def.validate(parsed.settingValue)
      if (error) throw new Error(`${error}\n${usage()}`)
    }
    const path = await writeSettingToScope(parsed, key, parsed.settingValue)
    console.log(`\n  Set ${parsed.settingArg} = ${parsed.settingValue} (${parsed.scope})`)
    console.log(`  Saved: ${path}\n`)
    return
  }

  if (!/^\d+$/.test(parsed.settingValue)) {
    throw new Error(
      `Invalid value "${parsed.settingValue}". Must be a non-negative integer.\n${usage()}`
    )
  }
  const value = Number(parsed.settingValue)
  const path = await writeSettingToScope(parsed, key, value)
  const label = value === 0 ? "system default" : `${value}`
  console.log(`\n  Set ${parsed.settingArg} = ${label} (${parsed.scope})`)
  console.log(`  Saved: ${path}\n`)
}

const DAEMON_PORT = Number(process.env.SWIZ_DAEMON_PORT) || 7943

/** Best-effort daemon notification after a settings write (issue #330). */
async function notifyDaemon(): Promise<void> {
  try {
    const resp = await fetch(`http://127.0.0.1:${DAEMON_PORT}/health`, {
      signal: AbortSignal.timeout(500),
    })
    if (!resp.ok) return
    console.log("  Daemon notified of settings change.")
  } catch {
    // Daemon not running — silently continue
  }
}

/** Write a single key-value pair to the appropriate scope via SettingsStore. */
async function writeSettingToScope(
  parsed: ParsedSettingsArgs,
  key: string,
  value: unknown
): Promise<string> {
  let path: string
  if (parsed.scope === "project") {
    path = await settingsStore.setProject(parsed.targetDir, key, value)
  } else if (parsed.scope === "session") {
    const sessionId = await resolveSessionId(parsed.sessionQuery, parsed.targetDir)
    path = await settingsStore.setSession(sessionId, key, value)
  } else {
    path = await settingsStore.setGlobal(key, value)
  }
  // The daemon's file watcher detects changes and calls flushSnapshots(),
  // which now also invalidates the settings TTL cache. The health check
  // here just confirms the daemon is alive — no explicit restart needed.
  await notifyDaemon()
  return path
}

async function disableHook(parsed: ParsedSettingsArgs): Promise<void> {
  const filename = parsed.settingArg
  if (!filename)
    throw new Error(`Missing hook filename.\nUsage: swiz settings disable-hook <filename>`)

  const scope = parsed.scope === "project" ? "project" : "global"
  const { path, alreadyDisabled } = await settingsStore.disableHook(
    scope,
    filename,
    parsed.targetDir
  )
  if (alreadyDisabled) {
    console.log(`\n  ${filename} is already disabled (${scope})\n`)
    return
  }
  console.log(`\n  Disabled hook: ${filename} (${scope})`)
  console.log(`  Saved: ${path}\n`)
}

async function enableHook(parsed: ParsedSettingsArgs): Promise<void> {
  const filename = parsed.settingArg
  if (!filename)
    throw new Error(`Missing hook filename.\nUsage: swiz settings enable-hook <filename>`)

  const scope = parsed.scope === "project" ? "project" : "global"
  const { path, wasEnabled } = await settingsStore.enableHook(scope, filename, parsed.targetDir)
  if (!wasEnabled) {
    console.log(`\n  ${filename} is not in the disabled list (${scope})\n`)
    return
  }
  console.log(`\n  Re-enabled hook: ${filename} (${scope})`)
  console.log(`  Saved: ${path}\n`)
}

function buildSettingOptions(): Array<{ flags: string; description: string }> {
  const options: Array<{ flags: string; description: string }> = []
  for (const def of SETTINGS_REGISTRY) {
    const alias = primaryAlias(def)
    if (def.kind === "boolean") {
      options.push({
        flags: `enable ${alias}`,
        description: def.docs?.enableDescription ?? `Enable ${alias}`,
      })
      options.push({
        flags: `disable ${alias}`,
        description: def.docs?.disableDescription ?? `Disable ${alias}`,
      })
      continue
    }
    const valuePlaceholder = def.docs?.valuePlaceholder ?? "value"
    options.push({
      flags: `set ${alias} <${valuePlaceholder}>`,
      description: def.docs?.setDescription ?? `Set ${alias}`,
    })
  }
  return options
}

export const settingsCommand: Command = {
  name: "settings",
  description: "View and modify swiz global and per-session settings",
  usage:
    "swiz settings [show | enable <setting> | disable <setting>] [--global | --project | --session [id]] [--dir <path>]",
  options: [
    { flags: "show", description: "Show current effective settings (default action)" },
    ...buildSettingOptions(),
    {
      flags: "--force, -f",
      description:
        "Override conflict checks when enabling settings that conflict with existing configuration",
    },
    {
      flags: "--global, -g",
      description: "Write to global settings (~/.swiz/settings.json) [default]",
    },
    {
      flags: "--project, -p",
      description: "Write to project settings (.swiz/config.json in --dir or cwd)",
    },
    {
      flags: "--session, -s [id]",
      description: "Write to session scope (latest for --dir by default, or prefix match by id)",
    },
    {
      flags: "--dir, -d <path>",
      description: "Target project directory for project/session scope",
    },
  ],
  async run(args) {
    const parsed = parseSettingsArgs(args)
    switch (parsed.action) {
      case "show":
        return showSettings(parsed)
      case "enable":
        return setBooleanSetting(true, parsed)
      case "disable":
        return setBooleanSetting(false, parsed)
      case "set":
        return setValueSetting(parsed)
      case "disable-hook":
        return disableHook(parsed)
      case "enable-hook":
        return enableHook(parsed)
    }
  },
}
