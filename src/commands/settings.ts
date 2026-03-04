import { dirname, join } from "node:path"
import { detectProjectStack, spawnSpeak } from "../../hooks/hook-utils.ts"
import {
  getEffectiveSwizSettings,
  getProjectSettingsPath,
  getSwizSettingsPath,
  readProjectSettings,
  readSwizSettings,
  resolvePolicy,
  writeProjectSettings,
  writeSwizSettings,
} from "../settings.ts"
import { findSessions, projectKeyFromCwd } from "../transcript-utils.ts"
import type { Command } from "../types.ts"

type BooleanSettingKey =
  | "autoContinue"
  | "critiquesEnabled"
  | "prMergeMode"
  | "pushGate"
  | "sandboxedEdits"
  | "speak"
  | "gitStatusGate"
  | "nonDefaultBranchGate"
  | "githubCiGate"
  | "changesRequestedGate"
  | "personalRepoIssuesGate"
type NumericSettingKey =
  | "prAgeGateMinutes"
  | "narratorSpeed"
  | "memoryLineThreshold"
  | "memoryWordThreshold"
type StringSettingKey = "narratorVoice" | "ambitionMode"
type SettingKey = BooleanSettingKey | NumericSettingKey | StringSettingKey
type Action = "show" | "enable" | "disable" | "set" | "disable-hook" | "enable-hook"
type SettingsScope = "global" | "project" | "session"

interface ParsedSettingsArgs {
  action: Action
  settingArg?: string
  settingValue?: string
  targetDir: string
  scope: SettingsScope
  sessionQuery: string | null
}

const HOME = process.env.HOME ?? "~"
const PROJECTS_DIR = join(HOME, ".claude", "projects")

function usage(): string {
  return (
    "Usage: swiz settings [show | enable <setting> | disable <setting> | set <setting> <value> | disable-hook <filename> | enable-hook <filename>] [--global | --project | --session [id]] [--dir <path>]\n" +
    "Scope: --global (default, ~/.swiz/settings.json), --project (.swiz/config.json), --session [id] (per-session)\n" +
    "Supported settings: auto-continue, critiques-enabled, pr-merge-mode, push-gate, sandboxed-edits, speak,\n" +
    "  pr-age-gate (minutes, 0 to disable), narrator-voice (string, e.g. Samantha),\n" +
    "  narrator-speed (words per minute, 0 for default), ambition-mode (standard|aggressive),\n" +
    "  memory-line-threshold (lines, default 1400), memory-word-threshold (words, default 5000)\n" +
    "Hook management: disable-hook <filename> (e.g. stop-github-ci.ts), enable-hook <filename>"
  )
}

function parseSetting(raw: string | undefined): SettingKey {
  if (!raw) throw new Error(`Missing setting name.\n${usage()}`)
  const value = raw.trim().toLowerCase()
  if (value === "auto-continue" || value === "autocontinue" || value === "auto_continue") {
    return "autoContinue"
  }
  if (
    value === "pr-merge-mode" ||
    value === "prmergemode" ||
    value === "pr_merge_mode" ||
    value === "pr-merge" ||
    value === "prmerge"
  ) {
    return "prMergeMode"
  }
  if (
    value === "pr-age-gate" ||
    value === "pragegate" ||
    value === "pr_age_gate" ||
    value === "pragegateminutes" ||
    value === "pr-age-gate-minutes"
  ) {
    return "prAgeGateMinutes"
  }
  if (value === "push-gate" || value === "pushgate" || value === "push_gate") {
    return "pushGate"
  }
  if (value === "sandboxed-edits" || value === "sandboxededits" || value === "sandboxed_edits") {
    return "sandboxedEdits"
  }
  if (value === "speak" || value === "tts") {
    return "speak"
  }
  if (
    value === "git-status-gate" ||
    value === "gitstatusgate" ||
    value === "git_status_gate" ||
    value === "git-status"
  ) {
    return "gitStatusGate"
  }
  if (
    value === "non-default-branch-gate" ||
    value === "nondefaultbranchgate" ||
    value === "non_default_branch_gate" ||
    value === "branch-gate"
  ) {
    return "nonDefaultBranchGate"
  }
  if (
    value === "github-ci-gate" ||
    value === "githubcigate" ||
    value === "github_ci_gate" ||
    value === "ci-gate"
  ) {
    return "githubCiGate"
  }
  if (
    value === "changes-requested-gate" ||
    value === "changesrequestedgate" ||
    value === "changes_requested_gate" ||
    value === "pr-review-gate"
  ) {
    return "changesRequestedGate"
  }
  if (
    value === "personal-repo-issues-gate" ||
    value === "personalrepoissuesgate" ||
    value === "personal_repo_issues_gate" ||
    value === "issue-gate"
  ) {
    return "personalRepoIssuesGate"
  }
  if (
    value === "critiques-enabled" ||
    value === "critiquesenabled" ||
    value === "critiques_enabled" ||
    value === "critiques"
  ) {
    return "critiquesEnabled"
  }
  if (
    value === "ambition-mode" ||
    value === "ambitionmode" ||
    value === "ambition_mode" ||
    value === "ambition"
  ) {
    return "ambitionMode"
  }
  if (
    value === "narrator-voice" ||
    value === "narratorvoice" ||
    value === "narrator_voice" ||
    value === "voice"
  ) {
    return "narratorVoice"
  }
  if (
    value === "narrator-speed" ||
    value === "narratorspeed" ||
    value === "narrator_speed" ||
    value === "speed"
  ) {
    return "narratorSpeed"
  }
  if (
    value === "memory-line-threshold" ||
    value === "memorylinethreshold" ||
    value === "memory_line_threshold"
  ) {
    return "memoryLineThreshold"
  }
  if (
    value === "memory-word-threshold" ||
    value === "memorywordthreshold" ||
    value === "memory_word_threshold"
  ) {
    return "memoryWordThreshold"
  }
  throw new Error(`Unknown setting: ${raw}\n${usage()}`)
}

function isNumericSetting(key: SettingKey): key is NumericSettingKey {
  return (
    key === "prAgeGateMinutes" ||
    key === "narratorSpeed" ||
    key === "memoryLineThreshold" ||
    key === "memoryWordThreshold"
  )
}

function isStringSetting(key: SettingKey): key is StringSettingKey {
  return key === "narratorVoice"
}

function parseSettingsArgs(args: string[]): ParsedSettingsArgs {
  const positionals: string[] = []
  let targetDir = process.cwd()
  let scope: SettingsScope = "global"
  let sessionQuery: string | null = null
  let scopeExplicit = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg) continue
    const next = args[i + 1]

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
  }
}

async function resolveSessionId(query: string | null, targetDir: string): Promise<string> {
  const projectKey = projectKeyFromCwd(targetDir)
  const projectDir = join(PROJECTS_DIR, projectKey)
  const sessions = await findSessions(projectDir)

  if (sessions.length === 0) {
    throw new Error(`No sessions found for: ${targetDir}\n(looked in: ${projectDir})`)
  }

  if (!query) return sessions[0]!.id

  const match = sessions.find((s) => s.id.startsWith(query))
  if (match) return match.id

  const available = sessions.map((s) => `  ${s.id}`).join("\n")
  throw new Error(`No session matching: ${query}\nAvailable sessions:\n${available}`)
}

function printSettings(
  effective: {
    autoContinue: boolean
    critiquesEnabled: boolean
    ambitionMode: string
    narratorVoice: string
    narratorSpeed: number
    prAgeGateMinutes: number
    prMergeMode: boolean
    pushGate: boolean
    sandboxedEdits: boolean
    speak: boolean
    gitStatusGate: boolean
    nonDefaultBranchGate: boolean
    githubCiGate: boolean
    changesRequestedGate: boolean
    personalRepoIssuesGate: boolean
    memoryLineThreshold: number
    memoryWordThreshold: number
    source: "global" | "session"
    disabledHooks?: string[]
  },
  path: string | null,
  fileExists: boolean,
  sessionId: string | null,
  projectPolicyInfo?: {
    configPath: string
    profile: string | null
    trivialMaxFiles: number
    trivialMaxLines: number
    source: "project" | "default"
    disabledHooks?: string[]
  },
  detectedStacks?: string[]
): void {
  console.log("\n  swiz settings\n")
  if (!path) {
    console.log("  config: unavailable (HOME not set)")
  } else {
    const sourceLabel = fileExists ? "custom" : "defaults"
    console.log(`  config: ${path} (${sourceLabel})`)
  }
  if (sessionId) console.log(`  scope: session ${sessionId}`)
  const scopeLabel = effective.source === "session" ? "session override" : "global/default"
  console.log(
    `  auto-continue:   ${effective.autoContinue ? "enabled" : "disabled"} (${scopeLabel})`
  )
  console.log(`  critiques:       ${effective.critiquesEnabled ? "enabled" : "disabled"} (global)`)
  console.log(`  ambition-mode:   ${effective.ambitionMode} (global)`)
  const ageGateLabel =
    effective.prAgeGateMinutes > 0 ? `${effective.prAgeGateMinutes} minutes` : "disabled"
  console.log(`  pr-age-gate:     ${ageGateLabel} (global)`)
  console.log(`  pr-merge-mode:   ${effective.prMergeMode ? "enabled" : "disabled"} (global)`)
  console.log(`  push-gate:       ${effective.pushGate ? "enabled" : "disabled"} (global)`)
  console.log(`  sandboxed-edits: ${effective.sandboxedEdits ? "enabled" : "disabled"} (global)`)
  console.log(`  speak:           ${effective.speak ? "enabled" : "disabled"} (global)`)
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
  const voiceLabel = effective.narratorVoice || "system default"
  console.log(`  narrator-voice:  ${voiceLabel} (global)`)
  const speedLabel =
    effective.narratorSpeed > 0 ? `${effective.narratorSpeed} wpm` : "system default"
  console.log(`  narrator-speed:  ${speedLabel} (global)`)
  console.log(`  memory-line-threshold: ${effective.memoryLineThreshold} (global)`)
  console.log(`  memory-word-threshold: ${effective.memoryWordThreshold} (global)`)

  const globalDisabled = effective.disabledHooks ?? []
  if (globalDisabled.length > 0) {
    console.log(`  disabled-hooks:  ${globalDisabled.join(", ")} (global)`)
  }

  if (projectPolicyInfo) {
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
    const projectDisabled = projectPolicyInfo.disabledHooks ?? []
    if (projectDisabled.length > 0) {
      console.log(`  disabled-hooks:  ${projectDisabled.join(", ")} (project)`)
    }
    if (detectedStacks !== undefined) {
      const stacksLabel = detectedStacks.length > 0 ? detectedStacks.join(", ") : "none detected"
      console.log(`  detected-stacks: ${stacksLabel}`)
    }
  }

  console.log("")
}

async function showSettings(parsed: ParsedSettingsArgs): Promise<void> {
  const sessionId =
    parsed.scope === "session"
      ? await resolveSessionId(parsed.sessionQuery, parsed.targetDir)
      : null
  const settings = await readSwizSettings({ strict: true })
  const effective = getEffectiveSwizSettings(settings, sessionId)
  const path = getSwizSettingsPath()
  const fileExists = path ? await Bun.file(path).exists() : false

  const projectSettings = await readProjectSettings(parsed.targetDir)
  const policy = resolvePolicy(projectSettings)
  const projectPolicyInfo = {
    configPath: getProjectSettingsPath(parsed.targetDir),
    profile: policy.profile,
    trivialMaxFiles: policy.trivialMaxFiles,
    trivialMaxLines: policy.trivialMaxLines,
    source: policy.source,
    disabledHooks: projectSettings?.disabledHooks,
  }

  printSettings(
    { ...effective, disabledHooks: settings.disabledHooks },
    path,
    fileExists,
    sessionId,
    projectPolicyInfo,
    detectProjectStack(parsed.targetDir)
  )
}

async function setBooleanSetting(enabled: boolean, parsed: ParsedSettingsArgs): Promise<void> {
  const key = parseSetting(parsed.settingArg)
  if (isNumericSetting(key) || isStringSetting(key)) {
    throw new Error(
      `"${parsed.settingArg}" is not a boolean setting. Use: swiz settings set ${parsed.settingArg} <value>\n${usage()}`
    )
  }

  const scopeLabel = parsed.scope
  let path: string

  if (parsed.scope === "session") {
    const sessionId = await resolveSessionId(parsed.sessionQuery, parsed.targetDir)
    const current = await readSwizSettings({ strict: true })
    const next = {
      ...current,
      sessions: {
        ...current.sessions,
        [sessionId]: {
          ...(current.sessions[sessionId] ?? { autoContinue: current.autoContinue }),
          [key]: enabled,
        },
      },
    }
    path = await writeSwizSettings(next)
    console.log(
      `\n  ${enabled ? "Enabled" : "Disabled"} ${parsed.settingArg ?? key} (session ${sessionId})`
    )
  } else if (parsed.scope === "project") {
    path = await writeProjectSettings(parsed.targetDir, { [key]: enabled })
    console.log(`\n  ${enabled ? "Enabled" : "Disabled"} ${parsed.settingArg ?? key} (project)`)
  } else {
    const current = await readSwizSettings({ strict: true })
    path = await writeSwizSettings({ ...current, [key]: enabled })
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

  if (isStringSetting(key)) {
    if (key === "ambitionMode") {
      if (parsed.settingValue !== "standard" && parsed.settingValue !== "aggressive") {
        throw new Error(
          `Invalid value "${parsed.settingValue}" for ambition-mode. Must be: standard | aggressive\n${usage()}`
        )
      }
    }
    const path = await writeSettingToScope(parsed, key, parsed.settingValue)
    console.log(`\n  Set ${parsed.settingArg} = ${parsed.settingValue} (${parsed.scope})`)
    console.log(`  Saved: ${path}\n`)
    return
  }

  const value = parseInt(parsed.settingValue, 10)
  if (Number.isNaN(value) || value < 0) {
    throw new Error(
      `Invalid value "${parsed.settingValue}". Must be a non-negative integer.\n${usage()}`
    )
  }
  const path = await writeSettingToScope(parsed, key, value)
  const label = value === 0 ? "system default" : `${value}`
  console.log(`\n  Set ${parsed.settingArg} = ${label} (${parsed.scope})`)
  console.log(`  Saved: ${path}\n`)
}

/** Write a single key-value pair to the appropriate scope. */
async function writeSettingToScope(
  parsed: ParsedSettingsArgs,
  key: string,
  value: unknown
): Promise<string> {
  if (parsed.scope === "project") {
    return writeProjectSettings(parsed.targetDir, { [key]: value })
  }
  if (parsed.scope === "session") {
    const sessionId = await resolveSessionId(parsed.sessionQuery, parsed.targetDir)
    const current = await readSwizSettings({ strict: true })
    return writeSwizSettings({
      ...current,
      sessions: {
        ...current.sessions,
        [sessionId]: {
          ...(current.sessions[sessionId] ?? { autoContinue: current.autoContinue }),
          [key]: value,
        },
      },
    })
  }
  // global
  const current = await readSwizSettings({ strict: true })
  return writeSwizSettings({ ...current, [key]: value })
}

async function disableHook(parsed: ParsedSettingsArgs): Promise<void> {
  const filename = parsed.settingArg
  if (!filename)
    throw new Error(`Missing hook filename.\nUsage: swiz settings disable-hook <filename>`)

  if (parsed.scope === "project") {
    const projectSettings = await readProjectSettings(parsed.targetDir)
    const existing = projectSettings?.disabledHooks ?? []
    if (existing.includes(filename)) {
      console.log(`\n  ${filename} is already disabled (project)\n`)
      return
    }
    const path = await writeProjectSettings(parsed.targetDir, {
      disabledHooks: [...existing, filename],
    })
    console.log(`\n  Disabled hook: ${filename} (project)`)
    console.log(`  Saved: ${path}\n`)
    return
  }

  const current = await readSwizSettings({ strict: true })
  const existing = current.disabledHooks ?? []
  if (existing.includes(filename)) {
    console.log(`\n  ${filename} is already disabled (global)\n`)
    return
  }
  const next = { ...current, disabledHooks: [...existing, filename] }
  const path = await writeSwizSettings(next)
  console.log(`\n  Disabled hook: ${filename} (global)`)
  console.log(`  Saved: ${path}\n`)
}

async function enableHook(parsed: ParsedSettingsArgs): Promise<void> {
  const filename = parsed.settingArg
  if (!filename)
    throw new Error(`Missing hook filename.\nUsage: swiz settings enable-hook <filename>`)

  if (parsed.scope === "project") {
    const projectSettings = await readProjectSettings(parsed.targetDir)
    const existing = projectSettings?.disabledHooks ?? []
    if (!existing.includes(filename)) {
      console.log(`\n  ${filename} is not in the disabled list (project)\n`)
      return
    }
    const path = await writeProjectSettings(parsed.targetDir, {
      disabledHooks: existing.filter((f) => f !== filename),
    })
    console.log(`\n  Re-enabled hook: ${filename} (project)`)
    console.log(`  Saved: ${path}\n`)
    return
  }

  const current = await readSwizSettings({ strict: true })
  const existing = current.disabledHooks ?? []
  if (!existing.includes(filename)) {
    console.log(`\n  ${filename} is not in the disabled list (global)\n`)
    return
  }
  const next = { ...current, disabledHooks: existing.filter((f) => f !== filename) }
  const path = await writeSwizSettings(next)
  console.log(`\n  Re-enabled hook: ${filename} (global)`)
  console.log(`  Saved: ${path}\n`)
}

export const settingsCommand: Command = {
  name: "settings",
  description: "View and modify swiz global and per-session settings",
  usage:
    "swiz settings [show | enable <setting> | disable <setting>] [--global | --project | --session [id]] [--dir <path>]",
  options: [
    { flags: "show", description: "Show current effective settings (default action)" },
    { flags: "enable auto-continue", description: "Enable stop auto-continue behavior" },
    { flags: "disable auto-continue", description: "Disable stop auto-continue behavior" },
    {
      flags: "enable sandboxed-edits",
      description: "Block file edits outside cwd and /tmp (default: enabled)",
    },
    {
      flags: "disable sandboxed-edits",
      description: "Allow file edits anywhere on the filesystem",
    },
    { flags: "enable speak", description: "Enable TTS narrator (speaks assistant text aloud)" },
    { flags: "disable speak", description: "Disable TTS narrator (default: disabled)" },
    {
      flags: "enable critiques-enabled",
      description: "Show Process/Product critique lines in auto-continue output (default: enabled)",
    },
    {
      flags: "disable critiques-enabled",
      description: "Suppress critique lines — only emit the next-step directive",
    },
    {
      flags: "set ambition-mode <standard|aggressive>",
      description:
        "Set auto-continue ambition level: standard (balanced) or aggressive (feature-gap focused)",
    },
    {
      flags: "set pr-age-gate <minutes>",
      description: "Set PR merge grace period in minutes (0 to disable, default: 10)",
    },
    {
      flags: "enable pr-merge-mode",
      description: "Enable merge-oriented PR hooks (default: enabled)",
    },
    {
      flags: "disable pr-merge-mode",
      description: "Disable merge-oriented PR hooks; keep creation-oriented guidance only",
    },
    {
      flags: "enable git-status-gate",
      description: "Enable stop-hook enforcement of git status / push state (default: enabled)",
    },
    {
      flags: "disable git-status-gate",
      description:
        "Disable stop-hook git status enforcement (allow stopping with uncommitted changes)",
    },
    {
      flags: "enable non-default-branch-gate",
      description: "Enable stop-hook blocking on feature branches (default: enabled)",
    },
    {
      flags: "disable non-default-branch-gate",
      description:
        "Disable stop-hook non-default-branch enforcement (allow stopping on any branch)",
    },
    {
      flags: "enable github-ci-gate",
      description: "Enable stop-hook GitHub CI enforcement (default: enabled)",
    },
    {
      flags: "disable github-ci-gate",
      description: "Disable stop-hook GitHub CI enforcement (manage CI follow-through manually)",
    },
    {
      flags: "set narrator-voice <name>",
      description: "Set TTS voice (e.g. Samantha, Alex; empty for system default)",
    },
    {
      flags: "set narrator-speed <wpm>",
      description: "Set TTS speaking rate in words per minute (0 for system default)",
    },
    {
      flags: "set memory-line-threshold <lines>",
      description: "Max lines for CLAUDE.md/memory files before compaction advice (default: 1400)",
    },
    {
      flags: "set memory-word-threshold <words>",
      description: "Max words for CLAUDE.md/memory files before compaction advice (default: 5000)",
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
