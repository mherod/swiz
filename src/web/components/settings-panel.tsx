import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from "react"
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
  taskDurationWarningMinutes: number
  largeFileSizeKb: number
}

const DEFAULT_GLOBAL_FORM: GlobalSettingsForm = {
  autoContinue: false,
  critiquesEnabled: false,
  prMergeMode: true,
  pushGate: true,
  sandboxedEdits: true,
  speak: false,
  autoSteer: false,
  gitStatusGate: true,
  ambitionMode: "standard",
  auditStrictness: "strict",
  memoryWordThreshold: 5000,
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
  taskDurationWarningMinutes: 45,
  largeFileSizeKb: 200,
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
}

function globalSettingsToForm(settings: Record<string, unknown>): GlobalSettingsForm {
  return {
    autoContinue: !!settings.autoContinue,
    critiquesEnabled: !!settings.critiquesEnabled,
    prMergeMode: settings.prMergeMode !== false,
    pushGate: settings.pushGate !== false,
    sandboxedEdits: settings.sandboxedEdits !== false,
    speak: !!settings.speak,
    autoSteer: !!settings.autoSteer,
    gitStatusGate: settings.gitStatusGate !== false,
    ambitionMode: (settings.ambitionMode as GlobalSettingsForm["ambitionMode"]) ?? "standard",
    auditStrictness:
      (settings.auditStrictness as GlobalSettingsForm["auditStrictness"]) ?? "strict",
    memoryWordThreshold: Number(settings.memoryWordThreshold) || 5000,
    memoryLineThreshold: Number(settings.memoryLineThreshold) || 1000,
    pushCooldownMinutes: Number(settings.pushCooldownMinutes) || 10,
    prAgeGateMinutes: Number(settings.prAgeGateMinutes) || 15,
    updateMemoryFooter: settings.updateMemoryFooter !== false,
    nonDefaultBranchGate: settings.nonDefaultBranchGate !== false,
    ignoreCi: !!settings.ignoreCi,
    githubCiGate: settings.githubCiGate !== false,
    changesRequestedGate: settings.changesRequestedGate !== false,
    personalRepoIssuesGate: settings.personalRepoIssuesGate !== false,
    issueCloseGate: !!settings.issueCloseGate,
    memoryUpdateReminder: !!settings.memoryUpdateReminder,
    qualityChecksGate: settings.qualityChecksGate !== false,
    skipSecretScan: !!settings.skipSecretScan,
    taskDurationWarningMinutes: Number(settings.taskDurationWarningMinutes) || 45,
    largeFileSizeKb: Number(settings.largeFileSizeKb) || 200,
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

function CheckboxField(props: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
  desc: string
}) {
  return (
    <div>
      <label className="inline-flex items-center gap-[7px] text-[#c4d3ef] text-[0.76rem] [&_input]:accent-[#77b7ff]">
        <input
          type="checkbox"
          checked={props.checked}
          onChange={(e) => props.onChange(e.target.checked)}
        />
        <span>{props.label}</span>
      </label>
      <p className="text-[0.7rem] text-[var(--text-muted)] mt-[2px] mb-[6px] leading-[1.4]">
        {props.desc}
      </p>
    </div>
  )
}

// --- Toggle definitions (data-driven to keep JSX compact) ---

const GLOBAL_NUMBER_FIELDS: Array<{
  key: keyof GlobalSettingsForm
  label: string
}> = [
  { key: "memoryLineThreshold", label: "Memory line threshold" },
  { key: "memoryWordThreshold", label: "Memory word threshold" },
  { key: "taskDurationWarningMinutes", label: "Task duration warning (min)" },
  { key: "largeFileSizeKb", label: "Large file size (KB)" },
  { key: "pushCooldownMinutes", label: "Push cooldown (min)" },
  { key: "prAgeGateMinutes", label: "PR age gate (min)" },
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
]

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
  label: string
  value: number | string
  onChange: (e: { target: { value: string } }) => void
  placeholder?: string
  type?: string
}) {
  return (
    <label className="grid gap-1 text-[0.75rem] text-[#b8c8ea]">
      <span>{props.label}</span>
      <input
        type={props.type ?? "number"}
        className="w-full border border-[rgba(109,136,196,0.42)] rounded-lg bg-[rgba(29,34,44,0.72)] text-[#dfe8fb] px-2 py-[7px] text-[0.8rem] focus-visible:outline-none focus-visible:border-[rgba(126,170,255,0.72)] focus-visible:shadow-[0_0_0_2px_rgba(97,144,240,0.2)]"
        value={props.value}
        onChange={props.onChange}
        placeholder={props.placeholder}
      />
    </label>
  )
}

function GlobalNumberFieldsGrid({
  form,
  num,
}: {
  form: GlobalSettingsForm
  num: (key: keyof GlobalSettingsForm) => (e: { target: { value: string } }) => void
}) {
  return (
    <div className="grid grid-cols-2 gap-4">
      {GLOBAL_NUMBER_FIELDS.map(({ key, label }) => (
        <label key={key} className="grid gap-1 text-[0.75rem] text-[#b8c8ea]">
          <span>{label}</span>
          <input
            type="number"
            className="w-full border border-[rgba(109,136,196,0.42)] rounded-lg bg-[rgba(29,34,44,0.72)] text-[#dfe8fb] px-2 py-[7px] text-[0.8rem] focus-visible:outline-none focus-visible:border-[rgba(126,170,255,0.72)] focus-visible:shadow-[0_0_0_2px_rgba(97,144,240,0.2)]"
            value={form[key] as number}
            onChange={num(key)}
          />
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
        <label
          key={key}
          className="grid gap-1 text-[0.75rem] text-[#b8c8ea]"
          htmlFor={`project-${key}`}
        >
          <span>{label}</span>
          <p className="text-[0.7rem] text-[var(--text-muted)] mt-[2px] mb-[6px] leading-[1.4]">
            {desc}
          </p>
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
      <NumberField
        label="Default branch"
        value={form.defaultBranch as string}
        type="text"
        onChange={(e) => set({ defaultBranch: e.target.value })}
      />
      <NumberField
        label="Task duration warning (min)"
        value={form.taskDurationWarningMinutes}
        onChange={optNum("taskDurationWarningMinutes")}
        placeholder="Inherit global"
      />
      <NumberField
        label="Trivial max files"
        value={form.trivialMaxFiles}
        onChange={(e) => set({ trivialMaxFiles: Number(e.target.value) })}
      />
      <NumberField
        label="Trivial max lines"
        value={form.trivialMaxLines}
        onChange={(e) => set({ trivialMaxLines: Number(e.target.value) })}
      />
      <NumberField
        label="Memory line threshold"
        value={form.memoryLineThreshold}
        onChange={optNum("memoryLineThreshold")}
        placeholder="Inherit global"
      />
      <NumberField
        label="Memory word threshold"
        value={form.memoryWordThreshold}
        onChange={optNum("memoryWordThreshold")}
        placeholder="Inherit global"
      />
      <NumberField
        label="Large file size (KB)"
        value={form.largeFileSizeKb}
        onChange={optNum("largeFileSizeKb")}
        placeholder="Inherit global"
      />
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
      <label className="grid gap-1 text-[0.75rem] text-[#b8c8ea]" htmlFor="global-ambition-mode">
        <span>Ambition mode</span>
        <p className="text-[0.7rem] text-[var(--text-muted)] mt-[2px] mb-[6px] leading-[1.4]">
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
      <label className="grid gap-1 text-[0.75rem] text-[#b8c8ea]" htmlFor="global-audit-strictness">
        <span>Audit strictness</span>
        <p className="text-[0.7rem] text-[var(--text-muted)] mt-[2px] mb-[6px] leading-[1.4]">
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

function GlobalSettingsColumn({
  form,
  setForm,
  error,
}: {
  form: GlobalSettingsForm
  setForm: (fn: GlobalSettingsForm | ((prev: GlobalSettingsForm) => GlobalSettingsForm)) => void
  error: string
}) {
  const set = (patch: Partial<GlobalSettingsForm>) => setForm((f) => ({ ...f, ...patch }))
  const num = (key: keyof GlobalSettingsForm) => (e: { target: { value: string } }) =>
    set({ [key]: Number(e.target.value) })

  return (
    <div className="grid gap-4 mb-4">
      <h3 className="text-[0.85rem] font-semibold text-[#c4d4f2] mb-4 uppercase tracking-[0.05em]">
        Global Settings
      </h3>
      {error && <p className="text-[#ff7e7e]">{error}</p>}
      <GlobalSelectFields form={form} set={set} />
      <GlobalNumberFieldsGrid form={form} num={num} />
      {GLOBAL_TOGGLES.map(({ key, label, desc }) => (
        <CheckboxField
          key={key}
          checked={form[key] as boolean}
          onChange={(v) => set({ [key]: v })}
          label={label}
          desc={desc}
        />
      ))}
    </div>
  )
}

function ProjectSettingsColumn({
  cwd,
  form,
  setForm,
  loading,
  loaded,
  error,
}: {
  cwd: string | null
  form: ProjectSettingsForm
  setForm: (fn: ProjectSettingsForm | ((prev: ProjectSettingsForm) => ProjectSettingsForm)) => void
  loading: boolean
  loaded: boolean
  error: string
}) {
  const set = (patch: Partial<ProjectSettingsForm>) => setForm((f) => ({ ...f, ...patch }))
  const optNum = (key: keyof ProjectSettingsForm) => (e: { target: { value: string } }) =>
    set({ [key]: e.target.value === "" ? "" : Number(e.target.value) })

  return (
    <div>
      <h3 className="text-[0.85rem] font-semibold text-[#c4d4f2] mb-4 uppercase tracking-[0.05em]">
        Project Settings
      </h3>

      {!cwd ? (
        <p className="metric-note mt-4">Select a project to edit project-specific settings.</p>
      ) : loading && !loaded ? (
        <p className="metric-note mt-4">Loading project settings...</p>
      ) : error && !loaded ? (
        <p className="text-[#ff7e7e] mt-4">{error}</p>
      ) : (
        <>
          <ProjectSelectFieldsGrid form={form} set={set} />
          <ProjectFieldsGrid form={form} set={set} optNum={optNum} />

          <CheckboxField
            checked={form.prMergeMode}
            onChange={(v) => set({ prMergeMode: v })}
            label="PR merge mode (Global fallback)"
            desc={
              'When Collaboration Mode is set to "Auto", this global toggle determines if pull requests are required.'
            }
          />
          <CheckboxField
            checked={form.strictNoDirectMain}
            onChange={(v) => set({ strictNoDirectMain: v })}
            label="Strict merge to main mode"
            desc="Enforces feature-branch workflows by blocking direct pushes to the main branch locally, even in solo repositories."
          />
          <CheckboxField
            checked={form.trunkMode}
            onChange={(v) => set({ trunkMode: v })}
            label="Trunk mode"
            desc="Work directly on the default branch with no feature branches or PRs. Overrides strict-no-direct-main and branch gate hooks. Blocks checkout/switch to other branches, gh pr checkout, and gh pr create."
          />
        </>
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

export function SettingsPanel({ cwd }: { cwd: string | null }): ReactElement {
  const data = useSettingsFetch(cwd)
  const { isSaving, status } = useAutoSave(cwd, data)
  const { globalForm, setGlobalForm, globalLoading, globalLoaded, globalError } = data
  const { projectForm, setProjectForm, projectLoading, projectLoaded, projectError } = data

  const statusText = isSaving ? "Saving..." : status || null

  if (globalLoading && !globalLoaded) {
    return (
      <div className="card gap-2">
        <p>Loading settings...</p>
      </div>
    )
  }

  if (globalError && !globalLoaded) {
    return (
      <div className="card gap-2">
        <h2 className="section-title">Settings</h2>
        <p className="text-[#ff7e7e]">{globalError}</p>
      </div>
    )
  }

  return (
    <section className="card gap-2 overflow-y-auto">
      <header className="flex items-center justify-between">
        <h2 className="section-title">Settings</h2>
        {statusText ? (
          <span className={isSaving ? "text-[#90a4c8] animate-pulse" : "text-[#8ae28a]"}>
            {statusText}
          </span>
        ) : null}
      </header>
      <p className="section-subtitle">Manage global behavior and project-specific overrides</p>
      <div className="grid gap-8 content-start md:grid-cols-2">
        <GlobalSettingsColumn form={globalForm} setForm={setGlobalForm} error={globalError} />
        <ProjectSettingsColumn
          cwd={cwd}
          form={projectForm}
          setForm={setProjectForm}
          loading={projectLoading}
          loaded={projectLoaded}
          error={projectError}
        />
      </div>
    </section>
  )
}
