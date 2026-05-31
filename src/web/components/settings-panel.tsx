import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { cn } from "../lib/cn.ts"
import { postJson } from "../lib/http.ts"
import { Select } from "./select.tsx"

interface GlobalSettingsForm {
  autoContinue: boolean
  critiquesEnabled: boolean
  prMergeMode: boolean
  pushGate: boolean
  sandboxedEdits: boolean
  speak: boolean
  autoSteer: boolean
  swizNotifyHooks: boolean
  autoSteerTranscriptWatching: boolean
  gitStatusGate: boolean
  ambitionMode: "standard" | "aggressive" | "creative" | "reflective"
  auditStrictness: "strict" | "relaxed" | "local-dev"
  memoryWordThreshold: number
  memoryLineThreshold: number
  pushCooldownMinutes: number
  prAgeGateMinutes: number
  updateMemoryFooter: boolean
  nonDefaultBranchGate: boolean
  ignoreCi: boolean
  githubCiGate: boolean
  changesRequestedGate: boolean
  personalRepoIssuesGate: boolean
  issueCloseGate: boolean
  memoryUpdateReminder: boolean
  qualityChecksGate: boolean
  skipSecretScan: boolean
  ignoreMcpTools: boolean
  relaxSubagentHooks: boolean
  mcpChannels: boolean
  autoTransition: boolean
  taskDurationWarningMinutes: number
  largeFileSizeKb: number
  largeFileSizeBlockKb: number
  transcriptMonitorMaxConcurrentDispatches: number
  enforceEndOfDay: boolean
  enforceUnblockMyself: boolean
  enforceMidSessionCheckin: boolean
}

// Matches DEFAULT_MEMORY_WORD_THRESHOLD in src/settings/resolution.ts — update both when the default changes.
const DEFAULT_MEMORY_WORD_THRESHOLD = 5000

const DEFAULT_GLOBAL_FORM: GlobalSettingsForm = {
  autoContinue: false,
  critiquesEnabled: false,
  prMergeMode: true,
  pushGate: true,
  sandboxedEdits: true,
  speak: false,
  autoSteer: false,
  swizNotifyHooks: false,
  autoSteerTranscriptWatching: false,
  gitStatusGate: true,
  ambitionMode: "standard",
  auditStrictness: "strict",
  memoryWordThreshold: DEFAULT_MEMORY_WORD_THRESHOLD,
  memoryLineThreshold: 1000,
  pushCooldownMinutes: 10,
  prAgeGateMinutes: 15,
  updateMemoryFooter: true,
  nonDefaultBranchGate: true,
  ignoreCi: false,
  githubCiGate: true,
  changesRequestedGate: true,
  personalRepoIssuesGate: true,
  issueCloseGate: false,
  memoryUpdateReminder: false,
  qualityChecksGate: true,
  skipSecretScan: false,
  ignoreMcpTools: true,
  relaxSubagentHooks: true,
  mcpChannels: false,
  autoTransition: true,
  taskDurationWarningMinutes: 45,
  largeFileSizeKb: 200,
  largeFileSizeBlockKb: 5120,
  transcriptMonitorMaxConcurrentDispatches: 0,
  enforceEndOfDay: true,
  enforceUnblockMyself: true,
  enforceMidSessionCheckin: false,
}

interface CachedProjectSettingsResponse {
  settings?: {
    collaborationMode?: "auto" | "solo" | "team" | "relaxed-collab"
    strictNoDirectMain?: boolean
    trunkMode?: boolean
    trivialMaxFiles?: number
    trivialMaxLines?: number
    defaultBranch?: string
    memoryLineThreshold?: number
    memoryWordThreshold?: number
    largeFileSizeKb?: number
    ambitionMode?: "standard" | "aggressive" | "creative" | "reflective"
    taskDurationWarningMinutes?: number
    transcriptMonitorMaxConcurrentDispatches?: number
    autoSteerTranscriptWatching?: boolean
    speak?: boolean
    skillRecencyMaxTurns?: number
    skillRecencyMaxAgeMinutes?: number
  } | null
  globalSettings?: {
    prMergeMode?: boolean
  } | null
}

interface ProjectSettingsForm {
  collaborationMode: "auto" | "solo" | "team" | "relaxed-collab"
  prMergeMode: boolean
  strictNoDirectMain: boolean
  trunkMode: boolean
  trivialMaxFiles: number
  trivialMaxLines: number
  defaultBranch: string
  memoryLineThreshold: number | ""
  memoryWordThreshold: number | ""
  largeFileSizeKb: number | ""
  ambitionMode: "standard" | "aggressive" | "creative" | "reflective" | "inherit"
  taskDurationWarningMinutes: number | ""
  transcriptMonitorMaxConcurrentDispatches: number | ""
  autoSteerTranscriptWatching: boolean | "inherit"
  speak: boolean | "inherit"
  skillRecencyMaxTurns: number | ""
  skillRecencyMaxAgeMinutes: number | ""
}

const DEFAULT_PROJECT_FORM: ProjectSettingsForm = {
  collaborationMode: "auto",
  prMergeMode: true,
  strictNoDirectMain: false,
  trunkMode: false,
  trivialMaxFiles: 2,
  trivialMaxLines: 50,
  defaultBranch: "main",
  memoryLineThreshold: "",
  memoryWordThreshold: "",
  largeFileSizeKb: "",
  ambitionMode: "inherit",
  taskDurationWarningMinutes: "",
  transcriptMonitorMaxConcurrentDispatches: "",
  autoSteerTranscriptWatching: "inherit",
  speak: "inherit",
  skillRecencyMaxTurns: "",
  skillRecencyMaxAgeMinutes: "",
}

function readBooleanSetting(settings: Record<string, unknown>, key: string, defaultValue = false) {
  return defaultValue ? settings[key] !== false : !!settings[key]
}

function readNumberSetting(settings: Record<string, unknown>, key: string, fallback: number) {
  return Number(settings[key]) || fallback
}

function readStringSetting<T extends string>(
  settings: Record<string, unknown>,
  key: string,
  fallback: T
) {
  return (settings[key] as T) ?? fallback
}

function globalSettingsToForm(settings: Record<string, unknown>): GlobalSettingsForm {
  return {
    autoContinue: readBooleanSetting(settings, "autoContinue"),
    critiquesEnabled: readBooleanSetting(settings, "critiquesEnabled"),
    prMergeMode: readBooleanSetting(settings, "prMergeMode", true),
    pushGate: readBooleanSetting(settings, "pushGate", true),
    sandboxedEdits: readBooleanSetting(settings, "sandboxedEdits", true),
    speak: readBooleanSetting(settings, "speak"),
    autoSteer: readBooleanSetting(settings, "autoSteer"),
    swizNotifyHooks: readBooleanSetting(settings, "swizNotifyHooks"),
    autoSteerTranscriptWatching: readBooleanSetting(settings, "autoSteerTranscriptWatching"),
    gitStatusGate: readBooleanSetting(settings, "gitStatusGate", true),
    ambitionMode: readStringSetting<GlobalSettingsForm["ambitionMode"]>(
      settings,
      "ambitionMode",
      "standard"
    ),
    auditStrictness: readStringSetting<GlobalSettingsForm["auditStrictness"]>(
      settings,
      "auditStrictness",
      "strict"
    ),
    memoryWordThreshold: readNumberSetting(
      settings,
      "memoryWordThreshold",
      DEFAULT_MEMORY_WORD_THRESHOLD
    ),
    memoryLineThreshold: readNumberSetting(settings, "memoryLineThreshold", 1000),
    pushCooldownMinutes: readNumberSetting(settings, "pushCooldownMinutes", 10),
    prAgeGateMinutes: readNumberSetting(settings, "prAgeGateMinutes", 15),
    updateMemoryFooter: readBooleanSetting(settings, "updateMemoryFooter", true),
    nonDefaultBranchGate: readBooleanSetting(settings, "nonDefaultBranchGate", true),
    ignoreCi: readBooleanSetting(settings, "ignoreCi"),
    githubCiGate: readBooleanSetting(settings, "githubCiGate", true),
    changesRequestedGate: readBooleanSetting(settings, "changesRequestedGate", true),
    personalRepoIssuesGate: readBooleanSetting(settings, "personalRepoIssuesGate", true),
    issueCloseGate: readBooleanSetting(settings, "issueCloseGate"),
    memoryUpdateReminder: readBooleanSetting(settings, "memoryUpdateReminder"),
    qualityChecksGate: readBooleanSetting(settings, "qualityChecksGate", true),
    skipSecretScan: readBooleanSetting(settings, "skipSecretScan"),
    ignoreMcpTools: readBooleanSetting(settings, "ignoreMcpTools", true),
    relaxSubagentHooks: readBooleanSetting(settings, "relaxSubagentHooks", true),
    mcpChannels: readBooleanSetting(settings, "mcpChannels"),
    autoTransition: readBooleanSetting(settings, "autoTransition", true),
    taskDurationWarningMinutes: readNumberSetting(settings, "taskDurationWarningMinutes", 45),
    largeFileSizeKb: readNumberSetting(settings, "largeFileSizeKb", 200),
    largeFileSizeBlockKb: readNumberSetting(settings, "largeFileSizeBlockKb", 5120),
    transcriptMonitorMaxConcurrentDispatches: readNumberSetting(
      settings,
      "transcriptMonitorMaxConcurrentDispatches",
      0
    ),
    enforceEndOfDay: readBooleanSetting(settings, "enforceEndOfDay", true),
    enforceUnblockMyself: readBooleanSetting(settings, "enforceUnblockMyself", true),
    enforceMidSessionCheckin: readBooleanSetting(settings, "enforceMidSessionCheckin"),
  }
}

const PROJECT_FORM_DEFAULTS: ProjectSettingsForm = {
  collaborationMode: "auto",
  prMergeMode: true,
  strictNoDirectMain: false,
  trunkMode: false,
  trivialMaxFiles: 2,
  trivialMaxLines: 50,
  defaultBranch: "main",
  memoryLineThreshold: "",
  memoryWordThreshold: "",
  largeFileSizeKb: "",
  ambitionMode: "inherit",
  taskDurationWarningMinutes: "",
  transcriptMonitorMaxConcurrentDispatches: "",
  autoSteerTranscriptWatching: "inherit",
  speak: "inherit",
  skillRecencyMaxTurns: "",
  skillRecencyMaxAgeMinutes: "",
}

function projectSettingsToForm(response: CachedProjectSettingsResponse): ProjectSettingsForm {
  const s = response.settings ?? {}
  const g = response.globalSettings ?? {}
  return {
    ...PROJECT_FORM_DEFAULTS,
    ...stripUndefined({
      collaborationMode: s.collaborationMode,
      prMergeMode: g.prMergeMode,
      strictNoDirectMain: s.strictNoDirectMain,
      trunkMode: s.trunkMode,
      trivialMaxFiles: s.trivialMaxFiles,
      trivialMaxLines: s.trivialMaxLines,
      defaultBranch: s.defaultBranch || undefined,
      memoryLineThreshold: s.memoryLineThreshold,
      memoryWordThreshold: s.memoryWordThreshold,
      largeFileSizeKb: s.largeFileSizeKb,
      ambitionMode: s.ambitionMode,
      taskDurationWarningMinutes: s.taskDurationWarningMinutes,
      transcriptMonitorMaxConcurrentDispatches: s.transcriptMonitorMaxConcurrentDispatches,
      autoSteerTranscriptWatching: (s.autoSteerTranscriptWatching ?? "inherit") as
        | boolean
        | "inherit",
      speak: (s.speak ?? "inherit") as boolean | "inherit",
      skillRecencyMaxTurns: s.skillRecencyMaxTurns,
      skillRecencyMaxAgeMinutes: s.skillRecencyMaxAgeMinutes,
    }),
  }
}

function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const result: Partial<T> = {}
  for (const key of Object.keys(obj) as Array<keyof T>) {
    if (obj[key] !== undefined) result[key] = obj[key]
  }
  return result
}

// --- Shared field components ---

function SettingsRiskConfirmation({
  id,
  action,
  onApply,
  onCancel,
}: {
  id: string
  action: string
  onApply: () => void
  onCancel: () => void
}) {
  return (
    <div id={`${id}-confirm`} className="settings-risk-confirm" role="alert">
      <span>{action}?</span>
      <button type="button" className="settings-risk-confirm-apply" onClick={onApply}>
        Apply
      </button>
      <button type="button" className="settings-risk-confirm-cancel" onClick={onCancel}>
        Cancel
      </button>
    </div>
  )
}

function CheckboxField(props: {
  id: string
  checked: boolean
  onChange: (v: boolean) => void
  label: string
  desc: string
  risk?: boolean
}) {
  const [pendingValue, setPendingValue] = useState<boolean | null>(null)
  const pendingAction =
    pendingValue === null ? null : pendingValue ? `Enable ${props.label}` : `Disable ${props.label}`
  const describedBy = pendingAction ? `${props.id}-desc ${props.id}-confirm` : `${props.id}-desc`

  const handleChange = (next: boolean) => {
    if (props.risk) {
      setPendingValue(next)
      return
    }
    props.onChange(next)
  }

  return (
    <div className={props.risk ? "settings-toggle settings-toggle-risk" : "settings-toggle"}>
      <label className="settings-toggle-row" htmlFor={props.id}>
        <input
          id={props.id}
          type="checkbox"
          checked={props.checked}
          onChange={(e) => handleChange(e.target.checked)}
          aria-describedby={describedBy}
        />
        <span className="settings-toggle-label">{props.label}</span>
        {props.risk ? <span className="settings-risk-badge">High impact</span> : null}
      </label>
      <p id={`${props.id}-desc`} className="settings-toggle-desc">
        {props.desc}
      </p>
      {pendingAction ? (
        <SettingsRiskConfirmation
          id={props.id}
          action={pendingAction}
          onApply={() => {
            if (pendingValue === null) return
            props.onChange(pendingValue)
            setPendingValue(null)
          }}
          onCancel={() => setPendingValue(null)}
        />
      ) : null}
    </div>
  )
}

// --- Toggle definitions (data-driven to keep JSX compact) ---

const GLOBAL_NUMBER_FIELDS: Array<{
  key: keyof GlobalSettingsForm
  label: string
  helper: string
  min: number
  max?: number
  step?: number
}> = [
  {
    key: "memoryLineThreshold",
    label: "Memory line threshold",
    helper: "Lines before memory review.",
    min: 50,
    max: 100_000,
  },
  {
    key: "memoryWordThreshold",
    label: "Memory word threshold",
    helper: "Words before memory review.",
    min: 100,
    max: 250_000,
  },
  {
    key: "taskDurationWarningMinutes",
    label: "Task duration warning",
    helper: "Minutes before a task is considered long-running.",
    min: 1,
    max: 1_440,
  },
  {
    key: "largeFileSizeKb",
    label: "Large file warning",
    helper: "KB threshold for large-file warnings.",
    min: 1,
    max: 1_048_576,
  },
  {
    key: "largeFileSizeBlockKb",
    label: "Large file block",
    helper: "KB threshold for blocking file edits.",
    min: 1,
    max: 1_048_576,
  },
  {
    key: "pushCooldownMinutes",
    label: "Push cooldown",
    helper: "Minutes to suppress repeated push prompts.",
    min: 0,
    max: 1_440,
  },
  {
    key: "prAgeGateMinutes",
    label: "PR age gate",
    helper: "Minutes before PR-age checks apply.",
    min: 0,
    max: 10_080,
  },
  {
    key: "transcriptMonitorMaxConcurrentDispatches",
    label: "Transcript dispatch cap",
    helper: "Maximum concurrent transcript dispatches. 0 means unlimited.",
    min: 0,
    max: 256,
  },
]

const PROJECT_SELECT_FIELDS: Array<{
  key: "ambitionMode" | "collaborationMode"
  label: string
  desc: string
  options: Array<{ label: string; value: string }>
}> = [
  {
    key: "ambitionMode",
    label: "Ambition mode override",
    desc: 'Project-specific override for the agent\'s operational tempo. "inherit" uses the global setting.',
    options: [
      { label: "inherit (global)", value: "inherit" },
      { label: "standard", value: "standard" },
      { label: "aggressive", value: "aggressive" },
      { label: "creative", value: "creative" },
      { label: "reflective", value: "reflective" },
    ],
  },
  {
    key: "collaborationMode",
    label: "Collaboration mode",
    desc: 'Determines how code is integrated. "Auto" falls back to PR merge mode. "Solo" pushes directly to main. "Team" and "Relaxed-collab" require PRs.',
    options: [
      { label: "auto", value: "auto" },
      { label: "solo", value: "solo" },
      { label: "team", value: "team" },
      { label: "relaxed-collab", value: "relaxed-collab" },
    ],
  },
]

const GLOBAL_TOGGLES: Array<{
  key: keyof GlobalSettingsForm
  label: string
  desc: string
}> = [
  {
    key: "autoContinue",
    label: "Auto-continue",
    desc: "Automatically trigger follow-up execution runs for pending tasks without user prompts.",
  },
  {
    key: "prMergeMode",
    label: "PR merge mode",
    desc: 'Require Pull Requests for merging code. Disabling allows direct pushes when collaboration mode is "auto".',
  },
  {
    key: "critiquesEnabled",
    label: "Critiques",
    desc: "Enable automated multi-agent code critiques during review phases.",
  },
  {
    key: "pushGate",
    label: "Push gate",
    desc: "Prevent git push commands unless explicitly allowed or required by a skill.",
  },
  {
    key: "sandboxedEdits",
    label: "Sandboxed edits",
    desc: "Restrict file write operations to the current project directory only.",
  },
  {
    key: "speak",
    label: "Speak",
    desc: "Enable text-to-speech audio narration of certain notifications and events.",
  },
  {
    key: "autoSteer",
    label: "Auto-steer",
    desc: "Type 'Continue' into the terminal after every tool call via AppleScript.",
  },
  {
    key: "swizNotifyHooks",
    label: "Pseudo hooks",
    desc: "Allow transcript/session monitoring to synthesize pseudo-hook dispatches in the daemon.",
  },
  {
    key: "autoSteerTranscriptWatching",
    label: "Auto-steer transcript watching",
    desc: "Enable daemon-driven auto-steering by monitoring session transcripts for tool calls.",
  },
  {
    key: "updateMemoryFooter",
    label: "Update memory footer",
    desc: "Require updating CLAUDE.md memory when the session completes successfully.",
  },
  {
    key: "gitStatusGate",
    label: "Git status gate",
    desc: "Block session completion when uncommitted or unpushed git changes are detected.",
  },
  {
    key: "nonDefaultBranchGate",
    label: "Non-default branch gate",
    desc: "Block completion on the default branch to encourage feature branch workflows.",
  },
  {
    key: "ignoreCi",
    label: "Ignore CI",
    desc: "Disable CI integration: no CI waits, CI hooks, CI status-line data, or CI evidence enforcement.",
  },
  {
    key: "githubCiGate",
    label: "GitHub CI gate",
    desc: "Block completion if GitHub Actions CI checks are failing.",
  },
  {
    key: "changesRequestedGate",
    label: "Changes requested gate",
    desc: "Block completion if the PR has a Changes Requested review state.",
  },
  {
    key: "personalRepoIssuesGate",
    label: "Personal repo issues gate",
    desc: "Suggest working on open issues in personal repositories upon completion.",
  },
  {
    key: "issueCloseGate",
    label: "Issue close gate",
    desc: "Block issue close commands unless explicitly allowed or required by a skill.",
  },
  {
    key: "memoryUpdateReminder",
    label: "Memory update reminder",
    desc: "Prompt to update memory files (CLAUDE.md / MEMORY.md) when session stops.",
  },
  {
    key: "qualityChecksGate",
    label: "Quality checks gate",
    desc: "Run lint and typecheck quality checks before allowing session stop.",
  },
  {
    key: "skipSecretScan",
    label: "Skip secret scan",
    desc: "Disable credential/secret pattern detection in the push-checks-gate hook.",
  },
  {
    key: "ignoreMcpTools",
    label: "Ignore MCP tools",
    desc: "Skip hook execution for MCP tool calls (tool names starting with mcp__).",
  },
  {
    key: "relaxSubagentHooks",
    label: "Relax subagent hooks",
    desc: "Skip enforcement hooks for Claude Code Task subagent sessions (agent_type/agent_id set). The commit/push safety floor stays active.",
  },
  {
    key: "mcpChannels",
    label: "MCP channels",
    desc: "Expose Claude MCP channel and permission capabilities. Auto-steer remains controlled separately.",
  },
  {
    key: "autoTransition",
    label: "Auto-transition status",
    desc: "Allow multi-step task status transitions (e.g. completing a pending task auto-transitions through in_progress).",
  },
  {
    key: "enforceEndOfDay",
    label: "Enforce end-of-day",
    desc: "Block session stop when unpushed commits exist until /end-of-day has been run.",
  },
  {
    key: "enforceUnblockMyself",
    label: "Stuck-state advisories",
    desc: "Show advisory context for repeated no-progress Edit, Write, or Bash loops.",
  },
  {
    key: "enforceMidSessionCheckin",
    label: "Enforce mid-session check-in (experimental)",
    desc: "Suggest /mid-session-checkin after 3+ hours when drift signals fire (uncommitted files, stale commit, new review requests).",
  },
]

const RISKY_GLOBAL_TOGGLES = new Set<keyof GlobalSettingsForm>([
  "autoContinue",
  "autoSteer",
  "autoSteerTranscriptWatching",
  "ignoreCi",
  "issueCloseGate",
  "skipSecretScan",
])

const GLOBAL_TOGGLE_GROUPS: Array<{
  title: string
  keys: Array<keyof GlobalSettingsForm>
}> = [
  {
    title: "Agent Behavior",
    keys: [
      "autoContinue",
      "critiquesEnabled",
      "speak",
      "autoSteer",
      "swizNotifyHooks",
      "autoSteerTranscriptWatching",
      "autoTransition",
    ],
  },
  {
    title: "MCP",
    keys: ["ignoreMcpTools", "relaxSubagentHooks", "mcpChannels"],
  },
  {
    title: "Git & Push",
    keys: [
      "prMergeMode",
      "pushGate",
      "gitStatusGate",
      "nonDefaultBranchGate",
      "githubCiGate",
      "changesRequestedGate",
      "ignoreCi",
    ],
  },
  {
    title: "Tasks & Memory",
    keys: [
      "updateMemoryFooter",
      "memoryUpdateReminder",
      "qualityChecksGate",
      "personalRepoIssuesGate",
      "issueCloseGate",
      "enforceEndOfDay",
      "enforceUnblockMyself",
      "enforceMidSessionCheckin",
    ],
  },
  {
    title: "Security",
    keys: ["sandboxedEdits", "skipSecretScan"],
  },
]

const GLOBAL_TOGGLE_BY_KEY = new Map(GLOBAL_TOGGLES.map((toggle) => [toggle.key, toggle]))

function matchesSettingsSearch(query: string, ...parts: string[]): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return parts.some((part) => part.toLowerCase().includes(q))
}

// --- Save logic (extracted to stay within per-function complexity limits) ---

async function saveSettingsToServer(opts: {
  cwd: string | null
  globalDirty: boolean
  globalForm: GlobalSettingsForm
  globalBaseline: GlobalSettingsForm
  onGlobalSaved: (form: GlobalSettingsForm) => void
  setGlobalSaving: (v: boolean) => void
  projectDirty: boolean
  projectForm: ProjectSettingsForm
  projectBaseline: ProjectSettingsForm
  onProjectSaved: (form: ProjectSettingsForm) => void
  setProjectSaving: (v: boolean) => void
}): Promise<void> {
  const promises: Promise<void>[] = []

  if (opts.globalDirty) {
    opts.setGlobalSaving(true)
    const updates: Record<string, unknown> = {}
    for (const key of Object.keys(opts.globalForm) as Array<keyof GlobalSettingsForm>) {
      if (opts.globalForm[key] !== opts.globalBaseline[key]) updates[key] = opts.globalForm[key]
    }
    promises.push(
      postJson<{ success: boolean; settings: Record<string, unknown> }>("/settings/global/update", {
        updates,
      })
        .then((r) => opts.onGlobalSaved(globalSettingsToForm(r.settings)))
        .finally(() => opts.setGlobalSaving(false))
    )
  }

  if (opts.projectDirty && opts.cwd) {
    opts.setProjectSaving(true)
    const updates: Record<string, unknown> = {}
    for (const key of Object.keys(opts.projectForm) as Array<keyof ProjectSettingsForm>) {
      if (opts.projectForm[key] !== opts.projectBaseline[key]) {
        updates[key] = opts.projectForm[key] === "" ? null : opts.projectForm[key]
      }
    }
    promises.push(
      postJson<CachedProjectSettingsResponse>("/settings/project/update", {
        cwd: opts.cwd,
        updates,
      })
        .then((r) => opts.onProjectSaved(projectSettingsToForm(r)))
        .finally(() => opts.setProjectSaving(false))
    )
  }

  await Promise.all(promises)
}

// --- Data-fetching hook ---

function useGlobalSettingsFetch() {
  const [form, setForm] = useState<GlobalSettingsForm>(DEFAULT_GLOBAL_FORM)
  const [baseline, setBaseline] = useState<GlobalSettingsForm>(DEFAULT_GLOBAL_FORM)
  const [loaded, setLoaded] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setLoaded(false)
    setError("")
    fetch("/settings/global")
      .then((res) => {
        if (!res.ok) throw new Error("Network response was not ok")
        return res.json()
      })
      .then((result) => {
        if (cancelled) return
        const next = globalSettingsToForm(result.settings || {})
        setForm(next)
        setBaseline(next)
        setLoaded(true)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : "Failed to load global settings")
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  return { form, setForm, baseline, setBaseline, loaded, loading, error, setError }
}

function useProjectSettingsFetch(cwd: string | null) {
  const [form, setForm] = useState<ProjectSettingsForm>(DEFAULT_PROJECT_FORM)
  const [baseline, setBaseline] = useState<ProjectSettingsForm>(DEFAULT_PROJECT_FORM)
  const [loaded, setLoaded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")

  useEffect(() => {
    if (!cwd) {
      setForm(DEFAULT_PROJECT_FORM)
      setBaseline(DEFAULT_PROJECT_FORM)
      setLoaded(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setLoaded(false)
    setError("")
    void postJson<CachedProjectSettingsResponse>("/settings/project", { cwd })
      .then((result) => {
        if (cancelled) return
        const next = projectSettingsToForm(result)
        setForm(next)
        setBaseline(next)
        setLoaded(true)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : "Failed to load project settings")
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [cwd])

  return { form, setForm, baseline, setBaseline, loaded, loading, error, setError }
}

function useSettingsFetch(cwd: string | null) {
  const global = useGlobalSettingsFetch()
  const project = useProjectSettingsFetch(cwd)

  return {
    globalForm: global.form,
    setGlobalForm: global.setForm,
    globalBaseline: global.baseline,
    setGlobalBaseline: global.setBaseline,
    globalLoading: global.loading,
    globalLoaded: global.loaded,
    globalError: global.error,
    projectForm: project.form,
    setProjectForm: project.setForm,
    projectBaseline: project.baseline,
    setProjectBaseline: project.setBaseline,
    projectLoading: project.loading,
    projectLoaded: project.loaded,
    projectError: project.error,
    setGlobalError: global.setError,
    setProjectError: project.setError,
  }
}

function NumberField(props: {
  id: string
  label: string
  value: number | string
  onChange: (e: { target: { value: string } }) => void
  placeholder?: string
  type?: string
  helper?: string
  min?: number
  max?: number
  step?: number
}) {
  return (
    <label className="settings-field" htmlFor={props.id}>
      <span className="settings-field-label">{props.label}</span>
      <input
        id={props.id}
        type={props.type ?? "number"}
        className="settings-input"
        value={props.value}
        onChange={props.onChange}
        placeholder={props.placeholder}
        min={props.min}
        max={props.max}
        step={props.step}
      />
      {props.helper ? <span className="settings-field-helper">{props.helper}</span> : null}
    </label>
  )
}

function GlobalNumberFieldsGrid({
  form,
  num,
  fields = GLOBAL_NUMBER_FIELDS,
}: {
  form: GlobalSettingsForm
  num: (key: keyof GlobalSettingsForm) => (e: { target: { value: string } }) => void
  fields?: typeof GLOBAL_NUMBER_FIELDS
}) {
  return (
    <div className="grid grid-cols-2 gap-4">
      {fields.map(({ key, label, helper, min, max, step }) => (
        <label key={key} className="settings-field" htmlFor={`global-${key}`}>
          <span className="settings-field-label">{label}</span>
          <input
            id={`global-${key}`}
            type="number"
            className="settings-input"
            value={form[key] as number}
            onChange={num(key)}
            min={min}
            max={max}
            step={step}
          />
          <span className="settings-field-helper">{helper}</span>
        </label>
      ))}
    </div>
  )
}

function ProjectSelectFieldsGrid({
  form,
  set,
}: {
  form: ProjectSettingsForm
  set: (patch: Partial<ProjectSettingsForm>) => void
}) {
  return (
    <>
      {PROJECT_SELECT_FIELDS.map(({ key, label, desc, options }) => (
        <label key={key} className="settings-field" htmlFor={`project-${key}`}>
          <span className="settings-field-label">{label}</span>
          <p className="settings-field-helper">{desc}</p>
          <Select
            id={`project-${key}`}
            value={form[key]}
            onChange={(e) => set({ [key]: e.target.value as never })}
            options={options}
          />
        </label>
      ))}
    </>
  )
}

const PROJECT_NUMBER_FIELDS: Array<{
  key: keyof ProjectSettingsForm
  id: string
  label: string
  helper?: string
  min?: number
  max?: number
  placeholder?: string
  type?: "number" | "text"
  optional?: boolean
}> = [
  {
    key: "defaultBranch",
    id: "project-default-branch",
    label: "Default branch",
    type: "text",
  },
  {
    key: "taskDurationWarningMinutes",
    id: "project-task-duration-warning",
    label: "Task duration warning",
    helper: "Minutes before task duration warnings apply.",
    min: 1,
    max: 1_440,
    placeholder: "Inherit global",
    optional: true,
  },
  {
    key: "trivialMaxFiles",
    id: "project-trivial-max-files",
    label: "Trivial max files",
    helper: "Maximum files for trivial-change classification.",
    min: 0,
    max: 100,
  },
  {
    key: "trivialMaxLines",
    id: "project-trivial-max-lines",
    label: "Trivial max lines",
    helper: "Maximum changed lines for trivial-change classification.",
    min: 0,
    max: 10_000,
  },
  {
    key: "memoryLineThreshold",
    id: "project-memory-line-threshold",
    label: "Memory line threshold",
    helper: "Lines before memory review.",
    min: 50,
    max: 100_000,
    placeholder: "Inherit global",
    optional: true,
  },
  {
    key: "memoryWordThreshold",
    id: "project-memory-word-threshold",
    label: "Memory word threshold",
    helper: "Words before memory review.",
    min: 100,
    max: 250_000,
    placeholder: "Inherit global",
    optional: true,
  },
  {
    key: "largeFileSizeKb",
    id: "project-large-file-size",
    label: "Large file size (KB)",
    helper: "KB threshold for large-file warnings.",
    min: 1,
    max: 1_048_576,
    placeholder: "Inherit global",
    optional: true,
  },
  {
    key: "transcriptMonitorMaxConcurrentDispatches",
    id: "project-transcript-dispatch-cap",
    label: "Transcript monitor dispatch cap",
    helper: "0 means unlimited.",
    min: 0,
    max: 256,
    placeholder: "Inherit global",
    optional: true,
  },
  {
    key: "skillRecencyMaxTurns",
    id: "project-skill-recency-turns",
    label: "Skill recency max turns",
    helper: "Turns before a skill mention stops counting as recent.",
    min: 0,
    max: 10_000,
    placeholder: "Inherit global",
    optional: true,
  },
  {
    key: "skillRecencyMaxAgeMinutes",
    id: "project-skill-recency-age",
    label: "Skill recency max age (min)",
    helper: "Minutes before a skill mention stops counting as recent.",
    min: 0,
    max: 10_080,
    placeholder: "Inherit global",
    optional: true,
  },
]

function projectFieldChangeHandler({
  field,
  set,
  optNum,
}: {
  field: (typeof PROJECT_NUMBER_FIELDS)[number]
  set: (patch: Partial<ProjectSettingsForm>) => void
  optNum: (key: keyof ProjectSettingsForm) => (e: { target: { value: string } }) => void
}) {
  if (field.optional) return optNum(field.key)
  if (field.type === "text") {
    return (e: { target: { value: string } }) => set({ [field.key]: e.target.value })
  }
  return (e: { target: { value: string } }) => set({ [field.key]: Number(e.target.value) })
}

function ProjectFieldsGrid({
  form,
  set,
  optNum,
}: {
  form: ProjectSettingsForm
  set: (patch: Partial<ProjectSettingsForm>) => void
  optNum: (key: keyof ProjectSettingsForm) => (e: { target: { value: string } }) => void
}) {
  return (
    <div className="grid grid-cols-2 gap-4">
      {PROJECT_NUMBER_FIELDS.map((field) => (
        <NumberField
          key={field.key}
          id={field.id}
          label={field.label}
          value={form[field.key] as number | string}
          type={field.type}
          onChange={projectFieldChangeHandler({ field, set, optNum })}
          placeholder={field.placeholder}
          helper={field.helper}
          min={field.min}
          max={field.max}
        />
      ))}
    </div>
  )
}

// --- Column components ---

function GlobalSelectFields({
  form,
  set,
}: {
  form: GlobalSettingsForm
  set: (patch: Partial<GlobalSettingsForm>) => void
}) {
  return (
    <>
      <label className="settings-field" htmlFor="global-ambition-mode">
        <span className="settings-field-label">Ambition mode</span>
        <p className="settings-field-helper">
          Agent's operational tempo. "standard" focuses on prompt completion. "aggressive" acts
          autonomously. "creative" focuses on exploratory design. "reflective" prioritizes analysis.
        </p>
        <Select
          id="global-ambition-mode"
          value={form.ambitionMode}
          onChange={(e) =>
            set({ ambitionMode: e.target.value as GlobalSettingsForm["ambitionMode"] })
          }
          options={[
            { label: "standard", value: "standard" },
            { label: "aggressive", value: "aggressive" },
            { label: "creative", value: "creative" },
            { label: "reflective", value: "reflective" },
          ]}
        />
      </label>
      <label className="settings-field" htmlFor="global-audit-strictness">
        <span className="settings-field-label">Audit strictness</span>
        <p className="settings-field-helper">
          Control task/evidence governance enforcement. "strict" always enforces. "relaxed" relaxes
          for exploratory sessions. "local-dev" relaxes locally but enforces for push/CI.
        </p>
        <Select
          id="global-audit-strictness"
          value={form.auditStrictness}
          onChange={(e) =>
            set({ auditStrictness: e.target.value as GlobalSettingsForm["auditStrictness"] })
          }
          options={[
            { label: "strict", value: "strict" },
            { label: "relaxed", value: "relaxed" },
            { label: "local-dev", value: "local-dev" },
          ]}
        />
      </label>
    </>
  )
}

type GlobalFormSetter = (patch: Partial<GlobalSettingsForm>) => void
type ProjectFormSetter = (patch: Partial<ProjectSettingsForm>) => void

function globalSectionVisibility(searchQuery: string) {
  const showModes = matchesSettingsSearch(searchQuery, "Modes", "Ambition mode", "Audit strictness")
  const visibleNumberFields = GLOBAL_NUMBER_FIELDS.filter(({ label, helper }) =>
    matchesSettingsSearch(searchQuery, "Thresholds", label, helper)
  )
  const visibleToggleGroups = GLOBAL_TOGGLE_GROUPS.map((group) => ({
    ...group,
    keys: group.keys.filter((key) => {
      const toggle = GLOBAL_TOGGLE_BY_KEY.get(key)
      return toggle
        ? matchesSettingsSearch(searchQuery, group.title, toggle.label, toggle.desc)
        : false
    }),
  })).filter((group) => group.keys.length > 0)

  return {
    showModes,
    visibleNumberFields,
    visibleToggleGroups,
    hasResults: showModes || visibleNumberFields.length > 0 || visibleToggleGroups.length > 0,
  }
}

function GlobalToggleGroupSection({
  group,
  form,
  set,
}: {
  group: (typeof GLOBAL_TOGGLE_GROUPS)[number]
  form: GlobalSettingsForm
  set: GlobalFormSetter
}) {
  return (
    <section className="settings-group">
      <h4>{group.title}</h4>
      <div className="settings-toggle-list">
        {group.keys.map((key) => {
          const toggle = GLOBAL_TOGGLE_BY_KEY.get(key)
          if (!toggle) return null
          return (
            <CheckboxField
              id={`global-${key}`}
              key={key}
              checked={form[key] as boolean}
              onChange={(v) => set({ [key]: v })}
              label={toggle.label}
              desc={toggle.desc}
              risk={RISKY_GLOBAL_TOGGLES.has(key)}
            />
          )
        })}
      </div>
    </section>
  )
}

function GlobalSettingsColumn({
  form,
  setForm,
  error,
  searchQuery,
}: {
  form: GlobalSettingsForm
  setForm: (fn: GlobalSettingsForm | ((prev: GlobalSettingsForm) => GlobalSettingsForm)) => void
  error: string
  searchQuery: string
}) {
  const set = (patch: Partial<GlobalSettingsForm>) => setForm((f) => ({ ...f, ...patch }))
  const num = (key: keyof GlobalSettingsForm) => (e: { target: { value: string } }) =>
    set({ [key]: Number(e.target.value) })
  const sections = globalSectionVisibility(searchQuery)

  return (
    <div className="settings-column">
      <h3 className="settings-column-title">Global Settings</h3>
      {error && <p className="text-[#ff7e7e]">{error}</p>}
      {!sections.hasResults ? <p className="empty">No global settings match this search.</p> : null}
      {sections.showModes ? (
        <section className="settings-group">
          <h4>Modes</h4>
          <GlobalSelectFields form={form} set={set} />
        </section>
      ) : null}
      {sections.visibleNumberFields.length > 0 ? (
        <section className="settings-group">
          <h4>Thresholds</h4>
          <GlobalNumberFieldsGrid form={form} num={num} fields={sections.visibleNumberFields} />
        </section>
      ) : null}
      {sections.visibleToggleGroups.map((group) => (
        <GlobalToggleGroupSection key={group.title} group={group} form={form} set={set} />
      ))}
    </div>
  )
}

function projectSectionVisibility(searchQuery: string) {
  const showModes = matchesSettingsSearch(searchQuery, "Modes", "Ambition", "Collaboration")
  const showThresholds = matchesSettingsSearch(
    searchQuery,
    "Thresholds",
    "Default branch",
    "Task duration",
    "Trivial",
    "Memory",
    "Large file",
    "Transcript",
    "Skill recency"
  )
  const showGit = matchesSettingsSearch(
    searchQuery,
    "Git & Push",
    "PR merge mode",
    "Strict merge",
    "Trunk mode"
  )
  const showAgent = matchesSettingsSearch(
    searchQuery,
    "Agent Behavior",
    "Auto-steer transcript watching",
    "Speak override"
  )
  return {
    showModes,
    showThresholds,
    showGit,
    showAgent,
    hasResults: showModes || showThresholds || showGit || showAgent,
  }
}

function renderProjectSettingsState({
  cwd,
  loading,
  loaded,
  error,
}: {
  cwd: string | null
  loading: boolean
  loaded: boolean
  error: string
}): ReactElement | null {
  if (!cwd) {
    return <p className="metric-note mt-4">Select a project to edit project-specific settings.</p>
  }
  if (loading && !loaded) return <p className="metric-note mt-4">Loading project settings...</p>
  if (error && !loaded) return <p className="text-[#ff7e7e] mt-4">{error}</p>
  return null
}

function ProjectGitSettings({ form, set }: { form: ProjectSettingsForm; set: ProjectFormSetter }) {
  return (
    <section className="settings-group">
      <h4>Git & Push</h4>
      <div className="settings-toggle-list">
        <CheckboxField
          id="project-pr-merge-mode"
          checked={form.prMergeMode}
          onChange={(v) => set({ prMergeMode: v })}
          label="PR merge mode (Global fallback)"
          desc={
            'When Collaboration Mode is set to "Auto", this global toggle determines if pull requests are required.'
          }
        />
        <CheckboxField
          id="project-strict-no-direct-main"
          checked={form.strictNoDirectMain}
          onChange={(v) => set({ strictNoDirectMain: v })}
          label="Strict merge to main mode"
          desc="Enforces feature-branch workflows by blocking direct pushes to the main branch locally, even in solo repositories."
          risk
        />
        <CheckboxField
          id="project-trunk-mode"
          checked={form.trunkMode}
          onChange={(v) => set({ trunkMode: v })}
          label="Trunk mode"
          desc="Work directly on the default branch with no feature branches or PRs. Overrides strict-no-direct-main and branch gate hooks. Blocks checkout/switch to other branches, gh pr checkout, and gh pr create."
          risk
        />
      </div>
    </section>
  )
}

function ProjectAgentSettings({
  form,
  set,
}: {
  form: ProjectSettingsForm
  set: ProjectFormSetter
}) {
  return (
    <section className="settings-group">
      <h4>Agent Behavior</h4>
      <ProjectBooleanOverrideField
        id="project-autoSteerTranscriptWatching"
        label="Auto-steer transcript watching override"
        desc={
          'Project-specific override for daemon-driven auto-steering. "inherit" uses the global setting.'
        }
        value={form.autoSteerTranscriptWatching}
        onChange={(value) => set({ autoSteerTranscriptWatching: value })}
      />
      <ProjectBooleanOverrideField
        id="project-speak"
        label="Speak override"
        desc={
          'Project-specific override for text-to-speech narration. "inherit" uses the global setting.'
        }
        value={form.speak}
        onChange={(value) => set({ speak: value })}
      />
    </section>
  )
}

function ProjectBooleanOverrideField({
  id,
  label,
  desc,
  value,
  onChange,
}: {
  id: string
  label: string
  desc: string
  value: boolean | "inherit"
  onChange: (value: boolean | "inherit") => void
}) {
  return (
    <label className="settings-field" htmlFor={id}>
      <span className="settings-field-label">{label}</span>
      <p className="settings-field-helper">{desc}</p>
      <Select
        id={id}
        value={String(value)}
        onChange={(e) => {
          const val = e.target.value
          onChange(val === "inherit" ? "inherit" : val === "true")
        }}
        options={[
          { label: "inherit (global)", value: "inherit" },
          { label: "enabled", value: "true" },
          { label: "disabled", value: "false" },
        ]}
      />
    </label>
  )
}

function ProjectSettingsSections({
  form,
  set,
  optNum,
  searchQuery,
}: {
  form: ProjectSettingsForm
  set: ProjectFormSetter
  optNum: (key: keyof ProjectSettingsForm) => (e: { target: { value: string } }) => void
  searchQuery: string
}) {
  const sections = projectSectionVisibility(searchQuery)
  return (
    <>
      {!sections.hasResults ? (
        <p className="empty">No project settings match this search.</p>
      ) : null}
      {sections.showModes ? (
        <section className="settings-group">
          <h4>Modes</h4>
          <ProjectSelectFieldsGrid form={form} set={set} />
        </section>
      ) : null}
      {sections.showThresholds ? (
        <section className="settings-group">
          <h4>Thresholds</h4>
          <ProjectFieldsGrid form={form} set={set} optNum={optNum} />
        </section>
      ) : null}
      {sections.showGit ? <ProjectGitSettings form={form} set={set} /> : null}
      {sections.showAgent ? <ProjectAgentSettings form={form} set={set} /> : null}
    </>
  )
}

function ProjectSettingsColumn({
  cwd,
  form,
  setForm,
  loading,
  loaded,
  error,
  searchQuery,
}: {
  cwd: string | null
  form: ProjectSettingsForm
  setForm: (fn: ProjectSettingsForm | ((prev: ProjectSettingsForm) => ProjectSettingsForm)) => void
  loading: boolean
  loaded: boolean
  error: string
  searchQuery: string
}) {
  const set = (patch: Partial<ProjectSettingsForm>) => setForm((f) => ({ ...f, ...patch }))
  const optNum = (key: keyof ProjectSettingsForm) => (e: { target: { value: string } }) =>
    set({ [key]: e.target.value === "" ? "" : Number(e.target.value) })
  const stateMessage = renderProjectSettingsState({ cwd, loading, loaded, error })

  return (
    <div className="settings-column">
      <h3 className="settings-column-title">Project Settings</h3>
      {stateMessage ? (
        stateMessage
      ) : (
        <ProjectSettingsSections form={form} set={set} optNum={optNum} searchQuery={searchQuery} />
      )}
    </div>
  )
}

function useDirtyState(
  globalForm: GlobalSettingsForm,
  globalBaseline: GlobalSettingsForm,
  projectForm: ProjectSettingsForm,
  projectBaseline: ProjectSettingsForm
) {
  const globalDirty = useMemo(
    () => JSON.stringify(globalForm) !== JSON.stringify(globalBaseline),
    [globalForm, globalBaseline]
  )
  const projectDirty = useMemo(
    () => JSON.stringify(projectForm) !== JSON.stringify(projectBaseline),
    [projectForm, projectBaseline]
  )
  return { globalDirty, projectDirty }
}

function useSaveEffect(
  isDirty: boolean,
  isSaving: boolean,
  projectDirty: boolean,
  cwd: string | null,
  performSave: () => Promise<void>
) {
  useEffect(() => {
    if (!isDirty || isSaving || (projectDirty && !cwd)) return
    const timer = setTimeout(() => {
      void performSave()
    }, 500)
    return () => clearTimeout(timer)
  }, [cwd, isDirty, isSaving, performSave, projectDirty])
}

function useSaveCallbacks(data: ReturnType<typeof useSettingsFetch>) {
  const { setGlobalForm, setGlobalBaseline, setProjectForm, setProjectBaseline } = data
  return {
    onGlobalSaved: useCallback(
      (f: typeof data.globalForm) => {
        setGlobalForm(f)
        setGlobalBaseline(f)
      },
      [setGlobalForm, setGlobalBaseline]
    ),
    onProjectSaved: useCallback(
      (f: typeof data.projectForm) => {
        setProjectForm(f)
        setProjectBaseline(f)
      },
      [setProjectForm, setProjectBaseline]
    ),
  }
}

type PerformSaveParams = {
  cwd: string | null
  globalDirty: boolean
  globalForm: ReturnType<typeof useSettingsFetch>["globalForm"]
  globalBaseline: ReturnType<typeof useSettingsFetch>["globalBaseline"]
  onGlobalSaved: ReturnType<typeof useSaveCallbacks>["onGlobalSaved"]
  projectDirty: boolean
  projectForm: ReturnType<typeof useSettingsFetch>["projectForm"]
  projectBaseline: ReturnType<typeof useSettingsFetch>["projectBaseline"]
  onProjectSaved: ReturnType<typeof useSaveCallbacks>["onProjectSaved"]
  setGlobalError: ReturnType<typeof useSettingsFetch>["setGlobalError"]
  setProjectError: ReturnType<typeof useSettingsFetch>["setProjectError"]
}

// Uses a ref to always-current params so performSave has a stable identity (empty dep array).
function usePerformSave(params: PerformSaveParams): {
  globalSaving: boolean
  projectSaving: boolean
  status: string
  performSave: () => Promise<void>
} {
  const [globalSaving, setGlobalSaving] = useState(false)
  const [projectSaving, setProjectSaving] = useState(false)
  const [status, setStatus] = useState("")
  const savingRef = useRef(false)
  const retryRef = useRef(false)
  const paramsRef = useRef(params)
  paramsRef.current = params

  const performSave = useCallback(async () => {
    if (savingRef.current) {
      retryRef.current = true
      return
    }
    savingRef.current = true
    const p = paramsRef.current
    p.setGlobalError("")
    p.setProjectError("")
    setStatus("Saving...")
    try {
      await saveSettingsToServer({ ...p, setGlobalSaving, setProjectSaving })
      setStatus("Settings saved successfully")
      setTimeout(() => setStatus(""), 2000)
    } catch (err) {
      setStatus("")
      const msg = err instanceof Error ? err.message : "Failed to save settings"
      if (p.globalDirty) p.setGlobalError(msg)
      if (p.projectDirty) p.setProjectError(msg)
    } finally {
      savingRef.current = false
      if (retryRef.current) {
        retryRef.current = false
        void performSave()
      }
    }
  }, [])

  return { globalSaving, projectSaving, status, performSave }
}

function useAutoSave(cwd: string | null, data: ReturnType<typeof useSettingsFetch>) {
  const {
    globalForm,
    globalBaseline,
    projectForm,
    projectBaseline,
    setGlobalError,
    setProjectError,
  } = data
  const { onGlobalSaved, onProjectSaved } = useSaveCallbacks(data)
  const { globalDirty, projectDirty } = useDirtyState(
    globalForm,
    globalBaseline,
    projectForm,
    projectBaseline
  )
  const { globalSaving, projectSaving, status, performSave } = usePerformSave({
    cwd,
    globalDirty,
    globalForm,
    globalBaseline,
    onGlobalSaved,
    projectDirty,
    projectForm,
    projectBaseline,
    onProjectSaved,
    setGlobalError,
    setProjectError,
  })
  const isDirty = globalDirty || projectDirty,
    isSaving = globalSaving || projectSaving
  useSaveEffect(isDirty, isSaving, projectDirty, cwd, performSave)
  return { globalDirty, projectDirty, isSaving, status }
}

// --- Main panel (composed from extracted hooks + columns) ---

function SettingsPanelHeader({
  isSaving,
  statusText,
}: {
  isSaving: boolean
  statusText: string | null
}) {
  return (
    <header className="settings-panel-header">
      <div>
        <h2 className="section-title">Settings</h2>
        <p className="section-subtitle">
          Manage global behavior and project-specific overrides. Changes auto-save after editing.
        </p>
      </div>
      <output
        className={
          isSaving ? "settings-save-status settings-save-status-saving" : "settings-save-status"
        }
        aria-live="polite"
      >
        {statusText ?? "Auto-save on"}
      </output>
    </header>
  )
}

function SettingsSearchField({
  value,
  onChange,
}: {
  value: string
  onChange: (value: string) => void
}) {
  return (
    <label className="settings-search" htmlFor="settings-search">
      <span className="sr-only">Search settings</span>
      <input
        id="settings-search"
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search settings..."
        aria-label="Search settings"
      />
    </label>
  )
}

function SettingsColumns({
  cwd,
  data,
  searchQuery,
}: {
  cwd: string | null
  data: ReturnType<typeof useSettingsFetch>
  searchQuery: string
}) {
  return (
    <div className="settings-grid">
      <GlobalSettingsColumn
        form={data.globalForm}
        setForm={data.setGlobalForm}
        error={data.globalError}
        searchQuery={searchQuery}
      />
      <ProjectSettingsColumn
        cwd={cwd}
        form={data.projectForm}
        setForm={data.setProjectForm}
        loading={data.projectLoading}
        loaded={data.projectLoaded}
        error={data.projectError}
        searchQuery={searchQuery}
      />
    </div>
  )
}

function SettingsPanelMessage({
  className,
  title,
  message,
}: {
  className?: string
  title?: string
  message: string
}) {
  return (
    <section className={cn("card gap-2 settings-panel", className)}>
      {title ? <h2 className="section-title">{title}</h2> : null}
      <p className={title ? "text-[#ff7e7e]" : undefined}>{message}</p>
    </section>
  )
}

export function SettingsPanel({
  cwd,
  className,
}: {
  cwd: string | null
  className?: string
}): ReactElement {
  const data = useSettingsFetch(cwd)
  const { isSaving, status } = useAutoSave(cwd, data)
  const [settingsSearch, setSettingsSearch] = useState("")

  const statusText = isSaving ? "Saving..." : status || null

  if (data.globalLoading && !data.globalLoaded) {
    return <SettingsPanelMessage className={className} message="Loading settings..." />
  }

  if (data.globalError && !data.globalLoaded) {
    return (
      <SettingsPanelMessage className={className} title="Settings" message={data.globalError} />
    )
  }

  return (
    <section className={cn("card settings-panel", className)}>
      <SettingsPanelHeader isSaving={isSaving} statusText={statusText} />
      <SettingsSearchField value={settingsSearch} onChange={setSettingsSearch} />
      <SettingsColumns cwd={cwd} data={data} searchQuery={settingsSearch} />
    </section>
  )
}
