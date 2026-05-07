import type { EffectiveSwizSettings } from "./types"

export const BEHAVIOR_STEERING_SETTING_GROUPS = {
  workflow: [
    "collaborationMode",
    "trunkMode",
    "strictNoDirectMain",
    "prMergeMode",
    "prAgeGateMinutes",
    "pushGate",
    "pushCooldownMinutes",
  ],
  stopGates: [
    "gitStatusGate",
    "nonDefaultBranchGate",
    "githubCiGate",
    "ignoreCi",
    "changesRequestedGate",
    "personalRepoIssuesGate",
    "issueCloseGate",
    "qualityChecksGate",
    "enforceEndOfDay",
  ],
  taskGovernance: [
    "auditStrictness",
    "autoTransition",
    "actionPlanMerge",
    "taskDurationWarningMinutes",
  ],
  safeguards: [
    "sandboxedEdits",
    "skipSecretScan",
    "dirtyWorktreeThreshold",
    "largeFileSizeKb",
    "largeFileSizeBlockKb",
  ],
  memoryAndCheckins: [
    "memoryUpdateReminder",
    "updateMemoryFooter",
    "memoryLineThreshold",
    "memoryWordThreshold",
    "enforceMidSessionCheckin",
    "enforceMorningStandup",
    "enforceWeeklyRetro",
  ],
  automation: [
    "autoContinue",
    "autoSteer",
    "swizNotifyHooks",
    "autoSteerTranscriptWatching",
    "transcriptMonitorMaxConcurrentDispatches",
    "ambitionMode",
    "critiquesEnabled",
    "speak",
  ],
} as const satisfies Record<string, readonly (keyof EffectiveSwizSettings)[]>

export interface BehaviorSteeringContextOptions {
  defaultBranch?: string
  memoryLineThreshold?: number
  memoryWordThreshold?: number
  includeAutomation?: boolean
}

function sentenceList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? ""
  if (items.length === 2) return `${items[0]} and ${items[1]}`
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`
}

function defaultBranchName(options: BehaviorSteeringContextOptions): string {
  return options.defaultBranch ?? "the default branch"
}

function describeWorkflowMode(
  settings: EffectiveSwizSettings,
  options: BehaviorSteeringContextOptions
): string {
  const branch = defaultBranchName(options)

  if (settings.trunkMode && settings.strictNoDirectMain) {
    return "trunk mode conflicts with strict no-direct-main; resolve that before pushing"
  }
  if (settings.trunkMode) return `trunk mode keeps work on ${branch} with direct pushes when ready`
  if (settings.strictNoDirectMain) {
    return `strict no-direct-main requires a feature branch and PR before ${branch} pushes`
  }

  const collaborationModes: Record<string, string> = {
    auto: "collaboration mode is auto-detected from the repository",
    solo: `solo collaboration mode expects direct pushes to ${branch}`,
    team: "team collaboration mode expects feature branches and PRs",
    "relaxed-collab": "relaxed collaboration mode still prefers PR flow, with lighter gates",
  }
  return (
    collaborationModes[settings.collaborationMode] ??
    "collaboration mode is auto-detected from the repository"
  )
}

function describePrMergePolicy(settings: EffectiveSwizSettings): string {
  if (!settings.prMergeMode) return ""
  const age =
    settings.prAgeGateMinutes > 0 ? ` with a ${settings.prAgeGateMinutes} minute PR age gate` : ""
  return `PR merge guidance is active${age}`
}

function buildWorkflowContext(
  settings: EffectiveSwizSettings,
  options: BehaviorSteeringContextOptions
): string {
  const parts = [
    describeWorkflowMode(settings, options),
    settings.pushGate ? "push gate needs /push or explicit approval before pushing" : "",
    settings.pushCooldownMinutes > 0
      ? `${settings.pushCooldownMinutes} minute push cooldown is active`
      : "",
    describePrMergePolicy(settings),
  ].filter(Boolean)

  return `Workflow policy: ${sentenceList(parts)}.`
}

function describeCiGate(settings: EffectiveSwizSettings): string {
  if (settings.ignoreCi) return "CI integration is ignored"
  return settings.githubCiGate ? "passing GitHub CI" : ""
}

function enabledGateRows(settings: EffectiveSwizSettings): Array<[boolean, string]> {
  return [
    [settings.gitStatusGate, "clean git state before stop"],
    [settings.nonDefaultBranchGate, "default-branch sync for feature work"],
    [settings.changesRequestedGate, "addressed PR review feedback"],
    [settings.personalRepoIssuesGate, "triaged actionable GitHub issues"],
    [settings.issueCloseGate, "explicit approval before closing issues"],
    [settings.qualityChecksGate, "lint/typecheck quality checks"],
    [settings.enforceEndOfDay, "end-of-day handoff for unpushed commits"],
  ]
}

function buildStopGateContext(settings: EffectiveSwizSettings): string {
  const gates = [
    ...enabledGateRows(settings).flatMap(([enabled, label]) => (enabled ? [label] : [])),
    describeCiGate(settings),
  ].filter(Boolean)

  if (gates.length === 0) return ""
  return `Stop gates expect ${sentenceList(gates)}.`
}

function buildTaskGovernanceContext(settings: EffectiveSwizSettings): string {
  const transitions = settings.autoTransition
    ? "task status can auto-transition when appropriate"
    : "task status changes must be explicit"
  const actionPlans = settings.actionPlanMerge
    ? "action plans may create tasks automatically"
    : "action plans remain advisory until tasks are created"
  return `${[
    `Task governance: ${settings.auditStrictness} audit strictness`,
    transitions,
    actionPlans,
    `warn after ${settings.taskDurationWarningMinutes} minutes in progress`,
  ].join("; ")}.`
}

function buildSafeguardsContext(settings: EffectiveSwizSettings): string {
  const parts = [
    settings.sandboxedEdits ? "sandboxed edits are on" : "sandboxed edits are off",
    settings.skipSecretScan ? "secret scan is skipped" : "secret scan runs before push",
    `dirty worktree blocks at ${settings.dirtyWorktreeThreshold} files`,
    `large-file warning at ${settings.largeFileSizeKb}KB`,
    `large-file block at ${settings.largeFileSizeBlockKb}KB`,
  ]
  return `Safeguards: ${sentenceList(parts)}.`
}

function buildMemoryContext(
  settings: EffectiveSwizSettings,
  options: BehaviorSteeringContextOptions
): string {
  const reminders: string[] = []
  if (settings.memoryUpdateReminder) reminders.push("memory update reminder on stop")
  if (settings.updateMemoryFooter) reminders.push("memory footer in stop messages")
  if (settings.enforceMidSessionCheckin) reminders.push("mid-session check-in prompts")
  if (settings.enforceMorningStandup) reminders.push("morning standup prompts")
  if (settings.enforceWeeklyRetro) reminders.push("weekly retro prompts")

  const prefix = reminders.length > 0 ? `${sentenceList(reminders)}; ` : ""
  const lineThreshold = options.memoryLineThreshold ?? settings.memoryLineThreshold
  const wordThreshold = options.memoryWordThreshold ?? settings.memoryWordThreshold
  return (
    `Memory and check-ins: ${prefix}` +
    `compact memory around ${lineThreshold} lines or ${wordThreshold} words.`
  )
}

function buildAutomationContext(settings: EffectiveSwizSettings): string {
  const parts = [
    settings.autoContinue ? "auto-continue is on" : "auto-continue is off",
    `ambition mode is ${settings.ambitionMode}`,
    settings.critiquesEnabled ? "critique feedback is on" : "critique feedback is off",
    settings.autoSteer ? "terminal auto-steer is on" : "terminal auto-steer is off",
    settings.swizNotifyHooks ? "transcript pseudo-hooks are on" : "transcript pseudo-hooks are off",
    settings.autoSteerTranscriptWatching
      ? "daemon transcript watching is on"
      : "daemon transcript watching is off",
    settings.transcriptMonitorMaxConcurrentDispatches > 0
      ? `transcript dispatch cap is ${settings.transcriptMonitorMaxConcurrentDispatches}`
      : "transcript dispatch cap is unlimited",
    settings.speak ? "spoken narration is on" : "spoken narration is off",
  ]
  return `Automation: ${sentenceList(parts)}.`
}

export function buildBehaviorSteeringContext(
  settings: EffectiveSwizSettings,
  options: BehaviorSteeringContextOptions = {}
): string {
  const lines = [
    buildWorkflowContext(settings, options),
    buildStopGateContext(settings),
    buildTaskGovernanceContext(settings),
    buildSafeguardsContext(settings),
    buildMemoryContext(settings, options),
    options.includeAutomation ? buildAutomationContext(settings) : "",
  ].filter(Boolean)

  return lines.length > 0 ? `Swiz behavior settings:\n${lines.join("\n")}` : ""
}
