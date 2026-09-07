import { dirname, join, resolve } from "node:path"
import { z } from "zod"
import { detectCurrentAgent } from "../agent-paths.ts"
import { stderrLog } from "../debug.ts"
import { detectProjectStack } from "../detect-frameworks.ts"
import { suggest } from "../fuzzy.ts"
import { findGitWorkTree } from "../git-helpers.ts"
import {
  DEFAULT_MEMORY_LINE_THRESHOLD,
  DEFAULT_MEMORY_WORD_THRESHOLD,
  type EffectiveSwizSettings,
  getEffectiveSwizSettings,
  getProjectSettingsPath,
  getSwizSettingsPath,
  type ProjectSwizSettings,
  readGlobalExplicitSettingKeys,
  readProjectSettings,
  readSwizSettings,
  resolveMemoryThresholds,
  resolvePolicy,
  resolveSettingSourceTier,
  SETTINGS_REGISTRY,
  type SettingDef,
  type SettingsScope,
  type SwizSettings,
  settingSourceLabel,
  settingsStore,
} from "../settings.ts"
import { spawnSpeak } from "../speech.ts"
import { findAllProviderSessions } from "../transcript-utils.ts"
import type { Command } from "../types.ts"
import { isDaemonReady } from "./daemon/daemon-admin.ts"

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
  scopeExplicitlySet: boolean
  sessionQuery: string | null
  force: boolean
  json: boolean
  forgiving: boolean
}

/**
 * Auto-detect scope for a setting if user didn't explicitly specify one.
 * If a setting only supports one scope (e.g., project-only), auto-apply it.
 * Returns the resolved scope.
 */
function resolveSettingScope(
  key: SettingKey,
  requestedScope: SettingsScope,
  scopeExplicitlySet: boolean
): SettingsScope {
  const def = getSettingDef(key)

  // If user explicitly set a scope, use it (validation happens later)
  if (scopeExplicitlySet) {
    return requestedScope
  }

  // If requested scope is supported, use it
  if (def.scopes.includes(requestedScope)) {
    return requestedScope
  }

  // Personal settings still belong globally when invoked from a project.
  if (def.scopes.includes("global")) return "global"

  // Project-only settings can also be used outside a Git repository.
  if (def.scopes.length === 1) {
    return def.scopes[0] as SettingsScope
  }

  // Multiple scopes available but not the requested one - user needs to specify
  return requestedScope
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

function usage(): string {
  return (
    "Usage: swiz settings [show | enable <setting> | disable <setting> | set <setting> <value> | disable-hook <filename> | enable-hook <filename>] [--global | --project | --session [id]] [--dir <path>] [--force]\n" +
    "Scope defaults outside agents: project in a Git repo or with --dir; global elsewhere. Agents must specify scope.\n" +
    "Run swiz settings --help for all settings and options."
  )
}

function parseSetting(raw: string | undefined): SettingKey {
  if (!raw) throw new Error(`Missing setting name.\n${usage()}`)
  const normalized = raw.trim().toLowerCase()
  const key = ALIAS_MAP.get(normalized)
  if (key) return key as SettingKey
  const hint = suggest(normalized, ALIAS_MAP.keys())
  throw new Error(`Unknown setting: ${raw}${hint ? ` (did you mean: "${hint}"?)` : ""}\n${usage()}`)
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
  "--user": "global",
  "-u": "global",
  "--project": "project",
  "-p": "project",
  "--session": "session",
  "-s": "session",
}

const VALID_ACTIONS = new Set(["show", "enable", "disable", "set", "disable-hook", "enable-hook"])

interface SettingsArgState {
  positionals: string[]
  targetDir: string
  dirExplicitlySet: boolean
  scope: SettingsScope
  scopeExplicitlySet: boolean
  sessionQuery: string | null
  force: boolean
  json: boolean
}

const SIMPLE_FLAGS: Record<string, keyof Pick<SettingsArgState, "force" | "json">> = {
  "--force": "force",
  "-f": "force",
  "--json": "json",
}

function processScopeArg(
  args: string[],
  i: number,
  state: SettingsArgState,
  scope: SettingsScope
): number {
  if (state.scopeExplicitlySet && state.scope !== scope) {
    throw new Error(`Choose one scope: --global, --project, or --session [id].\n${usage()}`)
  }
  state.scope = scope
  state.scopeExplicitlySet = true
  const next = args[i + 1]
  if (
    scope === "session" &&
    next &&
    !next.startsWith("-") &&
    !VALID_ACTIONS.has(next.toLowerCase())
  ) {
    state.sessionQuery = next
    return i + 1
  }
  return i
}

function processSettingsArg(args: string[], i: number, state: SettingsArgState): number {
  const arg = args[i]!
  const next = args[i + 1]

  const simpleFlag = SIMPLE_FLAGS[arg]
  if (simpleFlag) {
    state[simpleFlag] = true
    return i
  }

  if (arg === "--dir" || arg === "-d") {
    if (!next || next.startsWith("-")) throw new Error(`Missing value for ${arg}.\n${usage()}`)
    state.targetDir = next
    state.dirExplicitlySet = true
    return i + 1
  }

  const scopeValue = SCOPE_FLAGS[arg]
  if (scopeValue) {
    return processScopeArg(args, i, state, scopeValue)
  }

  if (arg.startsWith("-") && !/^-\d/.test(arg)) {
    throw new Error(`Unknown option: ${arg}\n${usage()}`)
  }
  state.positionals.push(arg)
  return i
}

function inferSettingsScope(state: SettingsArgState, forgiving: boolean): void {
  if (state.scopeExplicitlySet) return
  if (!forgiving) {
    throw new Error(`Scope is required. Pass --global, --project, or --session [id].\n${usage()}`)
  }
  const projectRoot = findGitWorkTree(state.targetDir)
  state.scope = state.dirExplicitlySet || projectRoot ? "project" : "global"
  state.targetDir = state.dirExplicitlySet
    ? resolve(state.targetDir)
    : (projectRoot ?? state.targetDir)
}

function parseSettingsArgs(args: string[]): ParsedSettingsArgs {
  const state: SettingsArgState = {
    positionals: [],
    targetDir: process.cwd(),
    dirExplicitlySet: false,
    scope: "global",
    scopeExplicitlySet: false,
    sessionQuery: null,
    force: false,
    json: false,
  }

  for (let i = 0; i < args.length; i++) {
    i = processSettingsArg(args, i, state)
  }

  const rawAction = (state.positionals[0] ?? "show").toLowerCase()
  if (!VALID_ACTIONS.has(rawAction)) {
    throw new Error(`Unknown subcommand: ${state.positionals[0]}\n${usage()}`)
  }
  const maxPositionals = rawAction === "show" ? 1 : rawAction === "set" ? 3 : 2
  if (state.positionals.length > maxPositionals) {
    throw new Error(`Unexpected argument: ${state.positionals[maxPositionals]}\n${usage()}`)
  }
  const forgiving = !detectCurrentAgent() && !process.env.CURSOR_TRACE_ID
  inferSettingsScope(state, forgiving)

  return {
    action: rawAction as Action,
    settingArg: state.positionals[1],
    settingValue: state.positionals[2],
    targetDir: state.targetDir,
    scope: state.scope,
    scopeExplicitlySet: state.scopeExplicitlySet,
    sessionQuery: state.sessionQuery,
    force: state.force,
    json: state.json,
    forgiving,
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
  trunkMode: boolean
  strictNoDirectMain: boolean
  auditStrictness: string
  auditStrictnessSource: "project" | "user" | "default"
  source: "project" | "default"
  autoSteerTranscriptWatching: boolean
  autoSteerTranscriptWatchingSource: "project" | "user" | "default"
  disabledHooks?: string[]
}

interface PrintSettingsOptions {
  effective: EffectiveSwizSettings & { disabledHooks?: string[] }
  path: string | null
  fileExists: boolean
  sessionId: string | null
  autoContinueSource?: "global" | "project" | "session"
  ambitionSource?: "global" | "project" | "session"
  strictNoDirectMainSource?: "global" | "project"
  projectPolicyInfo?: ProjectPolicyInfo
  detectedStacks?: string[]
  rawSettings?: SwizSettings
  /** Per-key provenance label. Without it, rows fall back to their previous fixed labels. */
  sourceOf?: (key: string) => string
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
  if (source === "session") return "(session)"
  if (source === "project") return "(project)"
  if (source === "global" || source === "user") return "(user)"
  return fallback
}

type SettingsRow = { label: string; value: string; scope?: string; description?: string }

function printAlignedRows(rows: SettingsRow[]): void {
  if (rows.length === 0) return
  const maxLabelLen = Math.max(...rows.map((r) => r.label.length))
  for (const row of rows) {
    const suffix = row.scope ? ` ${row.scope}` : ""
    console.log(`  ${row.label.padEnd(maxLabelLen)} ${row.value}${suffix}`)
    if (row.description) {
      console.log(`  ${" ".repeat(maxLabelLen)} ${row.description}`)
    }
  }
}

function boolToEnabledDisabled(v: boolean): "enabled" | "disabled" {
  return v ? "enabled" : "disabled"
}

function booleanRowsToSettingsRows(
  rows: BoolSettingRow[],
  effective: EffectiveSwizSettings,
  sourceOf?: (key: string) => string
): SettingsRow[] {
  return rows.map(([label, key, scope]) => {
    const def = DEF_BY_KEY.get(key)
    return {
      label,
      value: boolToEnabledDisabled(Boolean(effective[key])),
      // The literal in BoolSettingRow is a fallback only: it hardcodes "(user)" for every row,
      // which mislabelled project overrides and built-in defaults alike (#900).
      scope: sourceOf?.(key) ?? scope,
      description: def?.docs?.description,
    }
  })
}

/** Excluded from auto-generated boolean rows — these have custom scope labels or positioning. */
const SPECIAL_BOOL_KEYS = new Set(["autoContinue", "strictNoDirectMain", "trunkMode"])

/** Derive global boolean display rows from SETTINGS_REGISTRY. */
const GLOBAL_BOOL_ROWS: BoolSettingRow[] = SETTINGS_REGISTRY.filter(
  (d) => d.kind === "boolean" && d.scopes.includes("global") && !SPECIAL_BOOL_KEYS.has(d.key)
).map((d) => [`${d.aliases[0]}:`, d.key as keyof EffectiveSwizSettings, "(user)"])

/** Derive global numeric/string display from SETTINGS_REGISTRY. */
function formatNumericDisplay(numVal: number, placeholder: string | undefined): string {
  if (placeholder === "minutes") return numVal > 0 ? `${numVal} minutes` : "disabled"
  if (placeholder === "wpm") return numVal > 0 ? `${numVal} wpm` : "system default"
  return String(numVal)
}

function formatSettingValue(def: (typeof SETTINGS_REGISTRY)[number], value: unknown): string {
  if (def.kind === "numeric")
    return formatNumericDisplay(value as number, def.docs?.valuePlaceholder)
  return (value as string) || "system default"
}

function numericGlobalSettingsRows(
  effective: EffectiveSwizSettings,
  rawSettings?: SwizSettings,
  sourceOf?: (key: string) => string
): SettingsRow[] {
  return SETTINGS_REGISTRY.filter(
    (def) => (def.kind === "numeric" || def.kind === "string") && def.scopes.includes("global")
  ).map((def) => {
    // Presence on `rawSettings` is not evidence of an explicit value: it has already been through
    // the schema, which materialises every default. Fall back to it only without a resolver.
    const isExplicitlySet =
      rawSettings !== undefined && rawSettings[def.key as keyof SwizSettings] !== undefined
    return {
      label: `${def.aliases[0] ?? def.key}:`,
      value: formatSettingValue(def, effective[def.key as keyof EffectiveSwizSettings]),
      scope: sourceOf?.(def.key) ?? (isExplicitlySet ? "(user)" : "(default)"),
      description: def.docs?.description,
    }
  })
}

function resolveGlobalScopes(
  effective: EffectiveSwizSettings,
  autoContinueSource: "global" | "project" | "session" | undefined,
  ambitionSource: "global" | "project" | "session" | undefined,
  strictNoDirectMainSource: "global" | "project" | undefined
): { autoContinue: string; base: string; ambition: string; collaboration: string; strict: string } {
  const base = effective.source === "session" ? "(session)" : "(user)"
  return {
    autoContinue: resolveScopeLabel(autoContinueSource, "(user)"),
    base,
    ambition: resolveScopeLabel(ambitionSource, "(default)"),
    collaboration: effective.collaborationMode === "auto" ? "(default)" : base,
    strict: strictNoDirectMainSource === "project" ? "(project)" : "(user)",
  }
}

function descFor(key: string): string | undefined {
  return DEF_BY_KEY.get(key)?.docs?.description
}

/** Source-attribution inputs for the global rows, grouped so the row builders stay within arity. */
interface GlobalRowSources {
  autoContinueSource?: "global" | "project" | "session"
  ambitionSource?: "global" | "project" | "session"
  strictNoDirectMainSource?: "global" | "project"
  rawSettings?: SwizSettings
  /** Per-key provenance. Rows fall back to their previous fixed labels without it. */
  sourceOf?: (key: string) => string
}

function buildGlobalSettingsRows(
  effective: EffectiveSwizSettings & { disabledHooks?: string[] },
  sources: GlobalRowSources = {}
): SettingsRow[] {
  const { rawSettings, sourceOf } = sources
  const scopes = resolveGlobalScopes(
    effective,
    sources.autoContinueSource,
    sources.ambitionSource,
    sources.strictNoDirectMainSource
  )

  return [
    {
      label: "auto-continue:",
      value: boolToEnabledDisabled(effective.autoContinue),
      scope: sourceOf?.("autoContinue") ?? scopes.autoContinue,
      description: descFor("autoContinue"),
    },
    {
      label: "ambition-mode:",
      value: effective.ambitionMode,
      scope: sourceOf?.("ambitionMode") ?? scopes.ambition,
      description: descFor("ambitionMode"),
    },
    {
      label: "collaboration:",
      value: effective.collaborationMode,
      scope: sourceOf?.("collaborationMode") ?? scopes.collaboration,
      description: descFor("collaborationMode"),
    },
    ...booleanRowsToSettingsRows(GLOBAL_BOOL_ROWS, effective, sourceOf),
    {
      label: "strict-no-direct-main:",
      value: boolToEnabledDisabled(effective.strictNoDirectMain),
      scope: sourceOf?.("strictNoDirectMain") ?? scopes.strict,
      description: descFor("strictNoDirectMain"),
    },
    ...numericGlobalSettingsRows(effective, rawSettings, sourceOf),
  ]
}

function printGlobalSettings(
  effective: EffectiveSwizSettings & { disabledHooks?: string[] },
  sources: GlobalRowSources = {}
): void {
  const rows = buildGlobalSettingsRows(effective, sources)

  const globalDisabled = effective.disabledHooks ?? []
  if (globalDisabled.length > 0) {
    rows.push({ label: "disabled-hooks:", value: globalDisabled.join(", "), scope: "(user)" })
  }

  printAlignedRows(rows)
}

function printProjectPolicy(projectPolicyInfo: ProjectPolicyInfo, detectedStacks?: string[]): void {
  console.log("\n  project policy")
  const profileLabel = projectPolicyInfo.profile ?? "none"
  const scope = `(${projectPolicyInfo.source})`
  const rows: SettingsRow[] = [
    { label: "config:", value: projectPolicyInfo.configPath, scope },
    { label: "profile:", value: profileLabel, scope },
    {
      label: "trivial-max-files:",
      value: String(projectPolicyInfo.trivialMaxFiles),
      scope,
    },
    {
      label: "trivial-max-lines:",
      value: String(projectPolicyInfo.trivialMaxLines),
      scope,
    },
    {
      label: "default-branch:",
      value: projectPolicyInfo.defaultBranch,
      scope: `(${projectPolicyInfo.defaultBranchSource})`,
    },
    {
      label: "memory-line-threshold:",
      value: String(projectPolicyInfo.memoryLineThreshold),
      scope: `(${projectPolicyInfo.memoryLineSource})`,
    },
    {
      label: "memory-word-threshold:",
      value: String(projectPolicyInfo.memoryWordThreshold),
      scope: `(${projectPolicyInfo.memoryWordSource})`,
    },
    {
      label: "trunk-mode:",
      value: boolToEnabledDisabled(projectPolicyInfo.trunkMode),
      scope,
    },
    ...(projectPolicyInfo.trunkMode && projectPolicyInfo.strictNoDirectMain
      ? [
          {
            label: "branch-policy:",
            value: "conflict",
            scope: "(project)",
            description:
              "Project trunk mode conflicts with strict-no-direct-main; resolve trunk-mode and strict-no-direct-main before pushing.",
          },
        ]
      : projectPolicyInfo.trunkMode
        ? [
            {
              label: "branch-policy:",
              value:
                projectPolicyInfo.defaultBranchSource === "auto"
                  ? "direct push to the detected default branch"
                  : `direct push to ${projectPolicyInfo.defaultBranch}`,
              scope: "(project)",
              description:
                "Project trunk mode is authoritative; repository ownership and collaboration heuristics cannot require a feature branch or PR.",
            },
          ]
        : []),
    {
      label: "audit-strictness:",
      value: projectPolicyInfo.auditStrictness,
      scope: `(${projectPolicyInfo.auditStrictnessSource})`,
    },
    {
      label: "auto-steer-transcript-watching:",
      value: boolToEnabledDisabled(projectPolicyInfo.autoSteerTranscriptWatching),
      scope: `(${projectPolicyInfo.autoSteerTranscriptWatchingSource})`,
    },
  ]
  const projectDisabled = projectPolicyInfo.disabledHooks ?? []
  if (projectDisabled.length > 0) {
    rows.push({ label: "disabled-hooks:", value: projectDisabled.join(", "), scope: "(project)" })
  }

  printAlignedRows(rows)

  if (detectedStacks !== undefined) {
    const stacksLabel = detectedStacks.length > 0 ? detectedStacks.join(", ") : "none detected"
    console.log(`  detected-stacks: ${stacksLabel}`)
  }
}

function printSettings(opts: PrintSettingsOptions): void {
  printHeader(opts.path, opts.fileExists, opts.sessionId)
  printGlobalSettings(opts.effective, {
    autoContinueSource: opts.autoContinueSource,
    ambitionSource: opts.ambitionSource,
    strictNoDirectMainSource: opts.strictNoDirectMainSource,
    rawSettings: opts.rawSettings,
    sourceOf: opts.sourceOf,
  })
  if (opts.projectPolicyInfo) {
    printProjectPolicy(opts.projectPolicyInfo, opts.detectedStacks)
  }
  console.log("")
}

function resolveAutoContinueSource(
  sessionId: string | null,
  settings: SwizSettings,
  projectSettings: ProjectSwizSettings | null
): "global" | "project" | "session" {
  if (sessionId && settings.sessions[sessionId]?.autoContinue !== undefined) return "session"
  if (projectSettings?.autoContinue !== undefined) return "project"
  return "global"
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

function resolveAuditStrictness(
  settings: SwizSettings,
  projectSettings: ProjectSwizSettings | null
): Pick<ProjectPolicyInfo, "auditStrictness" | "auditStrictnessSource"> {
  if (projectSettings?.auditStrictness !== undefined) {
    return { auditStrictness: projectSettings.auditStrictness, auditStrictnessSource: "project" }
  }
  if (settings.auditStrictness !== undefined) {
    return { auditStrictness: settings.auditStrictness, auditStrictnessSource: "user" }
  }
  return { auditStrictness: "strict", auditStrictnessSource: "default" }
}

function resolveDefaultBranch(
  projectSettings: ProjectSwizSettings | null
): Pick<ProjectPolicyInfo, "defaultBranch" | "defaultBranchSource"> {
  return projectSettings?.defaultBranch
    ? { defaultBranch: projectSettings.defaultBranch, defaultBranchSource: "project" }
    : { defaultBranch: "auto-detect", defaultBranchSource: "auto" }
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
    ...resolveDefaultBranch(projectSettings),
    memoryLineThreshold: memoryThresholds.memoryLineThreshold,
    memoryLineSource: memoryThresholds.memoryLineSource,
    memoryWordThreshold: memoryThresholds.memoryWordThreshold,
    memoryWordSource: memoryThresholds.memoryWordSource,
    trunkMode: projectSettings?.trunkMode ?? false,
    strictNoDirectMain: projectSettings?.strictNoDirectMain ?? settings.strictNoDirectMain,
    ...resolveAuditStrictness(settings, projectSettings),
    source: policy.source,
    autoSteerTranscriptWatching:
      projectSettings?.autoSteerTranscriptWatching ?? settings.autoSteerTranscriptWatching,
    autoSteerTranscriptWatchingSource:
      projectSettings?.autoSteerTranscriptWatching !== undefined ? "project" : "user",
    disabledHooks: projectSettings?.disabledHooks,
  }
}

async function showSettings(parsed: ParsedSettingsArgs): Promise<void> {
  const sessionId =
    parsed.scope === "session"
      ? await resolveSessionId(parsed.sessionQuery, parsed.targetDir)
      : null
  const settings = await readSwizSettings({ strict: true })
  // Read separately from `settings`: the schema materialises defaults, so only the raw file
  // reveals which global values the user actually set (#900).
  const globalExplicitKeys = await readGlobalExplicitSettingKeys()
  const projectSettings = await readProjectSettings(parsed.targetDir)
  const effective = getEffectiveSwizSettings(settings, sessionId, projectSettings)
  const path = getSwizSettingsPath()
  const fileExists = path ? await Bun.file(path).exists() : false

  if (parsed.json) {
    console.log(JSON.stringify(effective, null, 2))
    return
  }

  const detectedStacks = await detectProjectStack(parsed.targetDir)
  printSettings({
    effective: { ...effective, disabledHooks: settings.disabledHooks },
    path,
    fileExists,
    sessionId,
    autoContinueSource: resolveAutoContinueSource(sessionId, settings, projectSettings),
    ambitionSource: resolveAmbitionSource(sessionId, settings, projectSettings),
    strictNoDirectMainSource:
      projectSettings?.strictNoDirectMain !== undefined ? "project" : "global",
    projectPolicyInfo: buildProjectPolicyInfo(parsed.targetDir, settings, projectSettings),
    detectedStacks,
    rawSettings: settings,
    sourceOf: (key) =>
      settingSourceLabel(
        resolveSettingSourceTier(key, {
          globalExplicitKeys,
          projectSettings,
          sessionSettings: sessionId ? settings.sessions[sessionId] : null,
        })
      ),
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

async function resolveWriteScopeLabel(parsed: ParsedSettingsArgs): Promise<string> {
  if (parsed.scope === "session") {
    const sessionId = await resolveSessionId(parsed.sessionQuery, parsed.targetDir)
    return `session ${sessionId}`
  }
  return parsed.scope
}

function printSettingChange(opts: {
  parsed: ParsedSettingsArgs
  key: string
  value: unknown
  verb: string
  scopeLabel: string
  path: string
}): void {
  const { parsed, key, value, verb, scopeLabel, path } = opts
  const def = DEF_BY_KEY.get(key)
  if (parsed.json) {
    console.log(
      JSON.stringify({
        action: verb.toLowerCase(),
        setting: key,
        value,
        scope: scopeLabel,
        path,
        description: def?.docs?.description,
        effect: def?.docs?.effectExplanation,
      })
    )
    return
  }
  console.log(`\n  ${verb} ${parsed.settingArg ?? key} (${scopeLabel})`)
  if (def?.docs?.effectExplanation) {
    console.log(`\n  Effect: ${def.docs.effectExplanation}`)
  }
  console.log(`\n  Saved: ${path}\n`)
}

async function enforceBooleanSettingConflicts(
  key: string,
  enabled: boolean,
  parsed: ParsedSettingsArgs
): Promise<void> {
  if (key === "strictNoDirectMain" && enabled) {
    await enforceStrictNoDirectMainConflicts(parsed)
  }
  if (key === "trunkMode" && enabled) {
    const projectSettings = await readProjectSettings(parsed.targetDir)
    if (projectSettings?.strictNoDirectMain && !parsed.force) {
      throw new Error(
        `Cannot enable trunk-mode: strictNoDirectMain is enabled for this project.\n` +
          `These settings are mutually exclusive. Disable strict-no-direct-main first,\n` +
          `or use --force to override:\n  swiz settings enable trunk-mode --project --force\n`
      )
    }
  }
}

async function setBooleanSetting(
  enabled: boolean,
  parsed: ParsedSettingsArgs,
  daemonReady: () => Promise<boolean>
): Promise<void> {
  const key = parseSetting(parsed.settingArg)
  if (isNumericSetting(key) || isStringSetting(key)) {
    throw new Error(
      `"${parsed.settingArg}" is not a boolean setting. Use: swiz settings set ${parsed.settingArg} <value>\n${usage()}`
    )
  }
  const resolvedScope = resolveSettingScope(key, parsed.scope, parsed.scopeExplicitlySet)
  validateSettingScope(key, resolvedScope, parsed.settingArg ?? key)
  const parsedWithResolvedScope = { ...parsed, scope: resolvedScope }
  await enforceBooleanSettingConflicts(key, enabled, parsedWithResolvedScope)

  const path = await writeSettingToScope(parsedWithResolvedScope, key, enabled, daemonReady)
  const verb = enabled ? "Enabled" : "Disabled"
  const scopeLabel = await resolveWriteScopeLabel(parsedWithResolvedScope)
  printSettingChange({
    parsed: parsedWithResolvedScope,
    key,
    value: enabled,
    verb,
    scopeLabel,
    path,
  })

  if (enabled && key === "speak") {
    const updatedSettings = await readSwizSettings()
    const speakScriptPath = join(dirname(Bun.main), "hooks", "speak.ts")
    await spawnSpeak("TTS enabled", updatedSettings, speakScriptPath)
  }
}

function printSetConfirmation(
  parsed: ParsedSettingsArgs & { scope: string },
  key: string,
  displayValue: string,
  path: string,
  def: ReturnType<typeof getSettingDef>
): void {
  if (parsed.json) {
    console.log(
      JSON.stringify({
        action: "set",
        setting: key,
        value: def.kind === "numeric" ? Number(displayValue) : displayValue,
        scope: parsed.scope,
        path,
        description: def.docs?.description,
        effect: def.docs?.effectExplanation,
      })
    )
    return
  }
  console.log(`\n  Set ${parsed.settingArg} = ${displayValue} (${parsed.scope})`)
  if (def.docs?.effectExplanation) {
    console.log(`\n  Effect: ${def.docs.effectExplanation}`)
  }
  console.log(`\n  Saved: ${path}\n`)
}

function parseNumericSettingValue(raw: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new Error(`Invalid value "${raw}". Must be a non-negative integer.\n${usage()}`)
  }
  return Number(raw)
}

function parseBooleanSettingValue(parsed: ParsedSettingsArgs, raw: string): boolean {
  const value = raw.trim().toLowerCase()
  const truthy = ["true", "on", "yes", "1", "enabled"]
  const falsy = ["false", "off", "no", "0", "disabled"]
  if (parsed.forgiving && (truthy.includes(value) || falsy.includes(value))) {
    return truthy.includes(value)
  }
  throw new Error(
    `Invalid boolean value "${raw}". Use: swiz settings enable ${parsed.settingArg} or swiz settings disable ${parsed.settingArg}\n${usage()}`
  )
}

function parseStringSettingValue(def: SettingDef, raw: string, forgiving: boolean): string {
  const value = forgiving && def.zodSchema instanceof z.ZodEnum ? raw.trim().toLowerCase() : raw
  const error = def.validate?.(value)
  if (error) throw new Error(`${error}\n${usage()}`)
  return value
}

async function setValueSetting(
  parsed: ParsedSettingsArgs,
  daemonReady: () => Promise<boolean>
): Promise<void> {
  const key = parseSetting(parsed.settingArg)
  if (parsed.settingValue === undefined) {
    throw new Error(
      `Missing value. Usage: swiz settings set ${parsed.settingArg} <value>\n${usage()}`
    )
  }
  const resolvedScope = resolveSettingScope(key, parsed.scope, parsed.scopeExplicitlySet)
  validateSettingScope(key, resolvedScope, parsed.settingArg ?? key)
  const resolved = { ...parsed, scope: resolvedScope }
  const def = getSettingDef(key)

  if (def.kind === "boolean") {
    return setBooleanSetting(
      parseBooleanSettingValue(parsed, parsed.settingValue),
      resolved,
      daemonReady
    )
  }

  if (def.kind === "string") {
    const value = parseStringSettingValue(def, parsed.settingValue, parsed.forgiving)
    const path = await writeSettingToScope(resolved, key, value, daemonReady)
    printSetConfirmation(resolved, key, value, path, def)
    return
  }

  const value = parseNumericSettingValue(parsed.settingValue)
  const path = await writeSettingToScope(resolved, key, value, daemonReady)
  const label = value === 0 ? "system default" : `${value}`
  printSetConfirmation(resolved, key, label, path, def)
}

/** Best-effort daemon notification after a settings write (issue #330). */
async function notifyDaemon(
  jsonOutput: boolean,
  daemonReady: () => Promise<boolean>
): Promise<void> {
  if (await daemonReady()) {
    if (!jsonOutput) console.log("  Daemon notified of settings change.")
  }
}

/** Write a single key-value pair to the appropriate scope via SettingsStore. */
async function writeSettingToScope(
  parsed: ParsedSettingsArgs,
  key: string,
  value: unknown,
  daemonReady: () => Promise<boolean>
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
  await notifyDaemon(parsed.json, daemonReady)
  return path
}

/** Hook lists exist only at global and project scope — see `src/settings/store.ts`. */
const HOOK_MANAGEMENT_SCOPES = ["global", "project"] as const

/**
 * Resolve the scope for a hook-management command.
 *
 * Throws before any store call: a `--session` scope used to be coerced to `"global"`, so a user
 * disabling one hook for one session silently disabled it across every project, even when the
 * session did not exist (#894). An explicit scope must constrain the operation, not be replaced.
 */
function resolveHookScope(parsed: ParsedSettingsArgs, action: string): "global" | "project" {
  if (parsed.scope === "session") {
    throw new Error(
      `${action} does not support --session scope. Supported: ${HOOK_MANAGEMENT_SCOPES.join(", ")}\n${usage()}`
    )
  }
  return parsed.scope === "project" ? "project" : "global"
}

async function disableHook(parsed: ParsedSettingsArgs): Promise<void> {
  const filename = parsed.settingArg
  if (!filename)
    throw new Error(`Missing hook filename.\nUsage: swiz settings disable-hook <filename>`)

  const scope = resolveHookScope(parsed, "disable-hook")
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

  const scope = resolveHookScope(parsed, "enable-hook")
  const { path, wasEnabled } = await settingsStore.enableHook(scope, filename, parsed.targetDir)
  if (!wasEnabled) {
    console.log(`\n  ${filename} is not in the disabled list (${scope})\n`)
    return
  }
  console.log(`\n  Re-enabled hook: ${filename} (${scope})`)
  console.log(`  Saved: ${path}\n`)
}

function settingDefToOptions(
  def: (typeof SETTINGS_REGISTRY)[number]
): Array<{ flags: string; description: string }> {
  const alias = primaryAlias(def)
  if (def.kind === "boolean") {
    return [
      { flags: `enable ${alias}`, description: def.docs?.enableDescription ?? `Enable ${alias}` },
      {
        flags: `disable ${alias}`,
        description: def.docs?.disableDescription ?? `Disable ${alias}`,
      },
    ]
  }
  const valuePlaceholder = def.docs?.valuePlaceholder ?? "value"
  return [
    {
      flags: `set ${alias} <${valuePlaceholder}>`,
      description: def.docs?.setDescription ?? `Set ${alias}`,
    },
  ]
}

function buildSettingOptions(): Array<{ flags: string; description: string }> {
  return SETTINGS_REGISTRY.flatMap(settingDefToOptions)
}

function isJsonHelpRequest(args: string[]): boolean {
  return (
    args.includes("--json") &&
    (args.includes("--help") || args.includes("-h") || args.includes("help"))
  )
}

export interface SettingsCommandOptions {
  daemonReady?: () => Promise<boolean>
}

export const settingsCommand: Command<SettingsCommandOptions> = {
  name: "settings",
  description: "View and modify swiz global, project, and session settings",
  usage:
    "swiz settings [show | enable <setting> | disable <setting> | set <setting> <value>] [--global | --project | --session [id]] [--dir <path>]",
  options: [
    { flags: "show", description: "Show current effective settings (default action)" },
    {
      flags: "scope",
      description:
        "Outside agents: project in a Git repo or with --dir, global elsewhere; global-only settings use global. Agents must specify scope.",
    },
    {
      flags: "set <boolean> <value>",
      description: "Outside agents, accepts true/false, on/off, yes/no, 1/0, enabled/disabled",
    },
    {
      flags: "--json",
      description:
        "Output as JSON (show: effective settings, enable/disable/set: confirmation, help: schema)",
    },
    ...buildSettingOptions(),
    {
      flags: "--force, -f",
      description:
        "Override conflict checks when enabling settings that conflict with existing configuration",
    },
    {
      flags: "--global, -g, --user, -u",
      description: "Write to global settings (~/.swiz/settings.json)",
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
  async run(args, options) {
    const daemonReady = options?.daemonReady ?? isDaemonReady
    if (isJsonHelpRequest(args)) {
      const schema = SETTINGS_REGISTRY.map((def) => ({
        key: def.key,
        kind: def.kind,
        scopes: def.scopes,
        aliases: def.aliases,
      }))
      console.log(JSON.stringify(schema, null, 2))
      return
    }
    const parsed = parseSettingsArgs(args)
    switch (parsed.action) {
      case "show":
        return showSettings(parsed)
      case "enable":
        return setBooleanSetting(true, parsed, daemonReady)
      case "disable":
        return setBooleanSetting(false, parsed, daemonReady)
      case "set":
        return setValueSetting(parsed, daemonReady)
      case "disable-hook":
        return disableHook(parsed)
      case "enable-hook":
        return enableHook(parsed)
    }
  },
}
