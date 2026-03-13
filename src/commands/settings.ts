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
  readProjectSettings,
  readSwizSettings,
  resolveMemoryThresholds,
  resolvePolicy,
  SETTINGS_REGISTRY,
  type SettingDef,
  type SettingsScope,
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

function parseSettingsArgs(args: string[]): ParsedSettingsArgs {
  const positionals: string[] = []
  let targetDir = process.cwd()
  let scope: SettingsScope = "global"
  let sessionQuery: string | null = null
  let scopeExplicit = false
  let force = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg) continue
    const next = args[i + 1]

    if (arg === "--force" || arg === "-f") {
      force = true
      continue
    }

    if (arg === "--dir" || arg === "-d") {
      if (!next || next.startsWith("-")) throw new Error(`Missing value for ${arg}.\n${usage()}`)
      targetDir = next
      i++
      continue
    }

    if (arg === "--global" || arg === "-g") {
      scope = "global"
      scopeExplicit = true
      continue
    }

    if (arg === "--project" || arg === "-p") {
      scope = "project"
      scopeExplicit = true
      continue
    }

    if (arg === "--session" || arg === "-s") {
      scope = "session"
      scopeExplicit = true
      if (next && !next.startsWith("-")) {
        sessionQuery = next
        i++
      }
      continue
    }

    positionals.push(arg)
  }

  // Backwards compat: if no explicit scope flag was given but --session was the old pattern
  // The new default is "global" which matches old behavior when --session was absent
  void scopeExplicit

  const rawAction = (positionals[0] ?? "show").toLowerCase()
  if (
    rawAction !== "show" &&
    rawAction !== "enable" &&
    rawAction !== "disable" &&
    rawAction !== "set" &&
    rawAction !== "disable-hook" &&
    rawAction !== "enable-hook"
  ) {
    throw new Error(`Unknown subcommand: ${positionals[0]}\n${usage()}`)
  }

  return {
    action: rawAction as Action,
    settingArg: positionals[1],
    settingValue: positionals[2],
    targetDir,
    scope,
    sessionQuery,
    force,
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

function printGlobalSettings(
  effective: EffectiveSwizSettings & { disabledHooks?: string[] },
  ambitionSource: "global" | "project" | "session" | undefined,
  strictNoDirectMainSource: "global" | "project" | undefined
): void {
  const scopeLabel = effective.source === "session" ? "session override" : "global/default"
  const ambitionScopeLabel =
    ambitionSource === "session"
      ? "session override"
      : ambitionSource === "project"
        ? "project override"
        : "global/default"
  const strictNoDirectMainScopeLabel =
    strictNoDirectMainSource === "project" ? "project override" : "global"
  const ageGateLabel =
    effective.prAgeGateMinutes > 0 ? `${effective.prAgeGateMinutes} minutes` : "disabled"
  const cooldownLabel =
    effective.pushCooldownMinutes > 0 ? `${effective.pushCooldownMinutes} minutes` : "disabled"
  const voiceLabel = effective.narratorVoice || "system default"
  const speedLabel =
    effective.narratorSpeed > 0 ? `${effective.narratorSpeed} wpm` : "system default"

  console.log(
    `  auto-continue:   ${effective.autoContinue ? "enabled" : "disabled"} (${scopeLabel})`
  )
  console.log(`  critiques:       ${effective.critiquesEnabled ? "enabled" : "disabled"} (global)`)
  console.log(`  ambition-mode:   ${effective.ambitionMode} (${ambitionScopeLabel})`)
  console.log(
    `  collaboration:   ${effective.collaborationMode} (${effective.collaborationMode === "auto" ? "default" : scopeLabel})`
  )
  console.log(`  pr-age-gate:     ${ageGateLabel} (global)`)
  console.log(`  push-cooldown:   ${cooldownLabel} (global)`)
  console.log(`  pr-merge-mode:   ${effective.prMergeMode ? "enabled" : "disabled"} (global)`)
  console.log(`  push-gate:       ${effective.pushGate ? "enabled" : "disabled"} (global)`)
  console.log(`  sandboxed-edits: ${effective.sandboxedEdits ? "enabled" : "disabled"} (global)`)
  console.log(`  speak:           ${effective.speak ? "enabled" : "disabled"} (global)`)
  console.log(
    `  update-memory-footer: ${effective.updateMemoryFooter ? "enabled" : "disabled"} (global)`
  )
  console.log(
    `  git-status-gate:         ${effective.gitStatusGate ? "enabled" : "disabled"} (global)`
  )
  console.log(
    `  non-default-branch-gate: ${effective.nonDefaultBranchGate ? "enabled" : "disabled"} (global)`
  )
  console.log(
    `  github-ci-gate:          ${effective.githubCiGate ? "enabled" : "disabled"} (global)`
  )
  console.log(
    `  changes-requested-gate:  ${effective.changesRequestedGate ? "enabled" : "disabled"} (global)`
  )
  console.log(
    `  issue-close-gate:        ${effective.issueCloseGate ? "enabled" : "disabled"} (global)`
  )
  console.log(
    `  strict-no-direct-main:   ${effective.strictNoDirectMain ? "enabled" : "disabled"} (${strictNoDirectMainScopeLabel})`
  )
  console.log(`  narrator-voice:  ${voiceLabel} (global)`)
  console.log(`  narrator-speed:  ${speedLabel} (global)`)
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

  const sessionAmbition =
    sessionId && settings.sessions[sessionId]
      ? settings.sessions[sessionId]?.ambitionMode
      : undefined
  const ambitionSource: "global" | "project" | "session" = sessionAmbition
    ? "session"
    : projectSettings?.ambitionMode
      ? "project"
      : "global"
  const strictNoDirectMainSource: "global" | "project" =
    projectSettings?.strictNoDirectMain !== undefined ? "project" : "global"

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
  const projectPolicyInfo = {
    configPath: getProjectSettingsPath(parsed.targetDir),
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

  const detectedStacks = await detectProjectStack(parsed.targetDir)
  printSettings({
    effective: { ...effective, disabledHooks: settings.disabledHooks },
    path,
    fileExists,
    sessionId,
    ambitionSource,
    strictNoDirectMainSource,
    projectPolicyInfo,
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

async function setBooleanSetting(enabled: boolean, parsed: ParsedSettingsArgs): Promise<void> {
  const key = parseSetting(parsed.settingArg)
  if (isNumericSetting(key) || isStringSetting(key)) {
    throw new Error(
      `"${parsed.settingArg}" is not a boolean setting. Use: swiz settings set ${parsed.settingArg} <value>\n${usage()}`
    )
  }
  validateSettingScope(key, parsed.scope, parsed.settingArg ?? key)

  // Conflict check for strictNoDirectMain (only when enabling)
  if (key === "strictNoDirectMain" && enabled) {
    const conflicts = await detectStrictNoDirectMainConflicts(parsed.targetDir)
    if (conflicts.length > 0 && !parsed.force) {
      const conflictList = conflicts.map((c) => `  - ${c}`).join("\n")
      throw new Error(
        `Cannot enable strict-no-direct-main: conflicting settings detected:\n\n${conflictList}\n\n` +
          `Resolve the conflicts above, or use --force to override:\n` +
          `  swiz settings enable strict-no-direct-main --force\n`
      )
    }
    if (conflicts.length > 0 && parsed.force) {
      stderrLog(
        "settings enable --force prints a warning about conflicting settings",
        `\n  Warning: enabling strict-no-direct-main with conflicting settings (--force):\n` +
          conflicts.map((c) => `    - ${c}`).join("\n") +
          `\n`
      )
    }
  }

  const scopeLabel = parsed.scope
  let path: string

  if (parsed.scope === "session") {
    const sessionId = await resolveSessionId(parsed.sessionQuery, parsed.targetDir)
    path = await settingsStore.setSession(sessionId, key, enabled)
    console.log(
      `\n  ${enabled ? "Enabled" : "Disabled"} ${parsed.settingArg ?? key} (session ${sessionId})`
    )
  } else if (parsed.scope === "project") {
    path = await settingsStore.setProject(parsed.targetDir, key, enabled)
    console.log(`\n  ${enabled ? "Enabled" : "Disabled"} ${parsed.settingArg ?? key} (project)`)
  } else {
    path = await settingsStore.setGlobal(key, enabled)
    console.log(
      `\n  ${enabled ? "Enabled" : "Disabled"} ${parsed.settingArg ?? key} (${scopeLabel})`
    )
  }

  console.log(`  Saved: ${path}\n`)

  // Test TTS immediately when enabling speak — use configured voice/speed
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

/** Write a single key-value pair to the appropriate scope via SettingsStore. */
async function writeSettingToScope(
  parsed: ParsedSettingsArgs,
  key: string,
  value: unknown
): Promise<string> {
  if (parsed.scope === "project") {
    return settingsStore.setProject(parsed.targetDir, key, value)
  }
  if (parsed.scope === "session") {
    const sessionId = await resolveSessionId(parsed.sessionQuery, parsed.targetDir)
    return settingsStore.setSession(sessionId, key, value)
  }
  return settingsStore.setGlobal(key, value)
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
