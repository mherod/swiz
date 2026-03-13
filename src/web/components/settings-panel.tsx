import { useCallback, useEffect, useMemo, useState } from "react"
import { postJson } from "../lib/http.ts"
import { Select } from "./select.tsx"

interface GlobalSettingsForm {
  autoContinue: boolean
  critiquesEnabled: boolean
  prMergeMode: boolean
  pushGate: boolean
  sandboxedEdits: boolean
  speak: boolean
  gitStatusGate: boolean
  ambitionMode: "standard" | "aggressive" | "creative" | "reflective"
  memoryWordThreshold: number
  memoryLineThreshold: number
  pushCooldownMinutes: number
  prAgeGateMinutes: number
  updateMemoryFooter: boolean
  nonDefaultBranchGate: boolean
  githubCiGate: boolean
  changesRequestedGate: boolean
  personalRepoIssuesGate: boolean
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
  gitStatusGate: true,
  ambitionMode: "standard",
  memoryWordThreshold: 5000,
  memoryLineThreshold: 1000,
  pushCooldownMinutes: 10,
  prAgeGateMinutes: 15,
  updateMemoryFooter: true,
  nonDefaultBranchGate: true,
  githubCiGate: true,
  changesRequestedGate: true,
  personalRepoIssuesGate: true,
  taskDurationWarningMinutes: 45,
  largeFileSizeKb: 200,
}

interface CachedProjectSettingsResponse {
  settings?: {
    collaborationMode?: "auto" | "solo" | "team" | "relaxed-collab"
    strictNoDirectMain?: boolean
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
    gitStatusGate: settings.gitStatusGate !== false,
    ambitionMode: (settings.ambitionMode as GlobalSettingsForm["ambitionMode"]) ?? "standard",
    memoryWordThreshold: Number(settings.memoryWordThreshold) || 5000,
    memoryLineThreshold: Number(settings.memoryLineThreshold) || 1000,
    pushCooldownMinutes: Number(settings.pushCooldownMinutes) || 10,
    prAgeGateMinutes: Number(settings.prAgeGateMinutes) || 15,
    updateMemoryFooter: settings.updateMemoryFooter !== false,
    nonDefaultBranchGate: settings.nonDefaultBranchGate !== false,
    githubCiGate: settings.githubCiGate !== false,
    changesRequestedGate: settings.changesRequestedGate !== false,
    personalRepoIssuesGate: settings.personalRepoIssuesGate !== false,
    taskDurationWarningMinutes: Number(settings.taskDurationWarningMinutes) || 45,
    largeFileSizeKb: Number(settings.largeFileSizeKb) || 200,
  }
}

function projectSettingsToForm(response: CachedProjectSettingsResponse): ProjectSettingsForm {
  const settings = response.settings
  const globalSettings = response.globalSettings
  return {
    collaborationMode: settings?.collaborationMode ?? "auto",
    prMergeMode: globalSettings?.prMergeMode ?? true,
    strictNoDirectMain: settings?.strictNoDirectMain ?? false,
    trivialMaxFiles: settings?.trivialMaxFiles ?? 2,
    trivialMaxLines: settings?.trivialMaxLines ?? 50,
    defaultBranch: settings?.defaultBranch || "main",
    memoryLineThreshold: settings?.memoryLineThreshold ?? "",
    memoryWordThreshold: settings?.memoryWordThreshold ?? "",
    largeFileSizeKb: settings?.largeFileSizeKb ?? "",
    ambitionMode: settings?.ambitionMode ?? "inherit",
    taskDurationWarningMinutes: settings?.taskDurationWarningMinutes ?? "",
  }
}

export function SettingsPanel({ cwd }: { cwd: string | null }) {
  // Global State
  const [globalForm, setGlobalForm] = useState<GlobalSettingsForm>(DEFAULT_GLOBAL_FORM)
  const [globalBaseline, setGlobalBaseline] = useState<GlobalSettingsForm>(DEFAULT_GLOBAL_FORM)
  const [globalLoading, setGlobalLoading] = useState(false)
  const [globalSaving, setGlobalSaving] = useState(false)

  // Project State
  const [projectForm, setProjectForm] = useState<ProjectSettingsForm>(DEFAULT_PROJECT_FORM)
  const [projectBaseline, setProjectBaseline] = useState<ProjectSettingsForm>(DEFAULT_PROJECT_FORM)
  const [projectLoading, setProjectLoading] = useState(false)
  const [projectSaving, setProjectSaving] = useState(false)

  // Status/Error
  const [error, setError] = useState("")
  const [status, setStatus] = useState("")

  // Fetch Global Settings
  useEffect(() => {
    let cancelled = false
    setGlobalLoading(true)
    fetch("/settings/global")
      .then((res) => {
        if (!res.ok) throw new Error("Network response was not ok")
        return res.json()
      })
      .then((result) => {
        if (cancelled) return
        const next = globalSettingsToForm(result.settings || {})
        setGlobalForm(next)
        setGlobalBaseline(next)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : "Failed to load global settings")
      })
      .finally(() => {
        if (!cancelled) setGlobalLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Fetch Project Settings
  useEffect(() => {
    if (!cwd) {
      setProjectForm(DEFAULT_PROJECT_FORM)
      setProjectBaseline(DEFAULT_PROJECT_FORM)
      return
    }
    let cancelled = false
    setProjectLoading(true)
    void postJson<CachedProjectSettingsResponse>("/settings/project", { cwd })
      .then((result) => {
        if (cancelled) return
        const next = projectSettingsToForm(result)
        setProjectForm(next)
        setProjectBaseline(next)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : "Failed to load project settings")
      })
      .finally(() => {
        if (!cancelled) setProjectLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [cwd])

  const globalDirty = useMemo(
    () => JSON.stringify(globalForm) !== JSON.stringify(globalBaseline),
    [globalForm, globalBaseline]
  )

  const projectDirty = useMemo(
    () => JSON.stringify(projectForm) !== JSON.stringify(projectBaseline),
    [projectForm, projectBaseline]
  )

  const isDirty = globalDirty || projectDirty
  const isSaving = globalSaving || projectSaving

  const performSave = useCallback(async () => {
    setError("")
    setStatus("Saving...")

    const promises: Promise<void>[] = []

    if (globalDirty) {
      setGlobalSaving(true)
      const updates: Record<string, unknown> = {}
      for (const key of Object.keys(globalForm) as Array<keyof GlobalSettingsForm>) {
        if (globalForm[key] !== globalBaseline[key]) {
          updates[key] = globalForm[key]
        }
      }

      const globalPromise = postJson<{ success: boolean; settings: Record<string, unknown> }>(
        "/settings/global/update",
        { updates }
      )
        .then((result) => {
          const next = globalSettingsToForm(result.settings)
          setGlobalForm(next)
          setGlobalBaseline(next)
        })
        .finally(() => {
          setGlobalSaving(false)
        })

      promises.push(globalPromise)
    }

    if (projectDirty && cwd) {
      setProjectSaving(true)
      const projectUpdates: Record<string, unknown> = {}
      for (const key of Object.keys(projectForm) as Array<keyof ProjectSettingsForm>) {
        if (projectForm[key] !== projectBaseline[key]) {
          projectUpdates[key] = projectForm[key] === "" ? null : projectForm[key]
        }
      }

      const projectPromise = postJson<CachedProjectSettingsResponse>("/settings/project/update", {
        cwd,
        updates: projectUpdates,
      })
        .then((result) => {
          const next = projectSettingsToForm(result)
          setProjectForm(next)
          setProjectBaseline(next)
        })
        .finally(() => {
          setProjectSaving(false)
        })

      promises.push(projectPromise)
    }

    try {
      await Promise.all(promises)
      setStatus("Settings saved successfully")
      setTimeout(() => setStatus(""), 2000)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save settings")
    }
  }, [cwd, globalBaseline, globalDirty, globalForm, projectBaseline, projectDirty, projectForm])

  useEffect(() => {
    if (!isDirty || isSaving || (projectDirty && !cwd)) return

    const timer = setTimeout(() => {
      void performSave()
    }, 500)

    return () => clearTimeout(timer)
  }, [cwd, isDirty, isSaving, performSave, projectDirty])

  if (globalLoading && !globalBaseline.ambitionMode) {
    return (
      <div className="card panel-settings">
        <p>Loading settings...</p>
      </div>
    )
  }

  return (
    <section className="card panel-settings settings-combined">
      <div className="settings-combined-header">
        <div className="settings-header-title-row">
          <h2 className="section-title">Settings</h2>
          <div className="settings-save-status">
            {isSaving ? (
              <span className="settings-status-saving">Saving...</span>
            ) : status ? (
              <span className="settings-status-ok">{status}</span>
            ) : error ? (
              <span className="settings-error">{error}</span>
            ) : null}
          </div>
        </div>
        <p className="section-subtitle">Manage global behavior and project-specific overrides</p>
      </div>

      <div className="settings-form">
        <div className="settings-layout">
          {/* Global Column */}
          <div className="settings-column">
            <h3 className="settings-column-title">Global Settings</h3>

            <div className="settings-fields">
              <label className="settings-label" htmlFor="global-ambition-mode">
                <span>Ambition mode</span>
                <p className="settings-desc">
                  Agent's operational tempo. "standard" focuses on prompt completion. "aggressive"
                  acts autonomously. "creative" focuses on exploratory design. "reflective"
                  prioritizes analysis.
                </p>
                <Select
                  id="global-ambition-mode"
                  value={globalForm.ambitionMode}
                  onChange={(e) =>
                    setGlobalForm({
                      ...globalForm,
                      ambitionMode: e.target.value as GlobalSettingsForm["ambitionMode"],
                    })
                  }
                  options={[
                    { label: "standard", value: "standard" },
                    { label: "aggressive", value: "aggressive" },
                    { label: "creative", value: "creative" },
                    { label: "reflective", value: "reflective" },
                  ]}
                />
              </label>

              <div className="settings-grid-cols-2">
                <label className="settings-label">
                  <span>Memory line threshold</span>
                  <input
                    type="number"
                    className="settings-input"
                    value={globalForm.memoryLineThreshold}
                    onChange={(e) =>
                      setGlobalForm({ ...globalForm, memoryLineThreshold: Number(e.target.value) })
                    }
                  />
                </label>
                <label className="settings-label">
                  <span>Memory word threshold</span>
                  <input
                    type="number"
                    className="settings-input"
                    value={globalForm.memoryWordThreshold}
                    onChange={(e) =>
                      setGlobalForm({ ...globalForm, memoryWordThreshold: Number(e.target.value) })
                    }
                  />
                </label>
                <label className="settings-label">
                  <span>Task duration warning (min)</span>
                  <input
                    type="number"
                    className="settings-input"
                    value={globalForm.taskDurationWarningMinutes}
                    onChange={(e) =>
                      setGlobalForm({
                        ...globalForm,
                        taskDurationWarningMinutes: Number(e.target.value),
                      })
                    }
                  />
                </label>
                <label className="settings-label">
                  <span>Large file size (KB)</span>
                  <input
                    type="number"
                    className="settings-input"
                    value={globalForm.largeFileSizeKb}
                    onChange={(e) =>
                      setGlobalForm({ ...globalForm, largeFileSizeKb: Number(e.target.value) })
                    }
                  />
                </label>
                <label className="settings-label">
                  <span>Push cooldown (min)</span>
                  <input
                    type="number"
                    className="settings-input"
                    value={globalForm.pushCooldownMinutes}
                    onChange={(e) =>
                      setGlobalForm({ ...globalForm, pushCooldownMinutes: Number(e.target.value) })
                    }
                  />
                </label>
                <label className="settings-label">
                  <span>PR age gate (min)</span>
                  <input
                    type="number"
                    className="settings-input"
                    value={globalForm.prAgeGateMinutes}
                    onChange={(e) =>
                      setGlobalForm({ ...globalForm, prAgeGateMinutes: Number(e.target.value) })
                    }
                  />
                </label>
              </div>

              <div>
                <label className="settings-checkbox">
                  <input
                    type="checkbox"
                    checked={globalForm.autoContinue}
                    onChange={(e) =>
                      setGlobalForm({ ...globalForm, autoContinue: e.target.checked })
                    }
                  />
                  <span>Auto-continue</span>
                </label>
                <p className="settings-desc">
                  Automatically trigger follow-up execution runs for pending tasks without user
                  prompts.
                </p>
              </div>

              <div>
                <label className="settings-checkbox">
                  <input
                    type="checkbox"
                    checked={globalForm.critiquesEnabled}
                    onChange={(e) =>
                      setGlobalForm({ ...globalForm, critiquesEnabled: e.target.checked })
                    }
                  />
                  <span>Critiques</span>
                </label>
                <p className="settings-desc">
                  Enable automated multi-agent code critiques during review phases.
                </p>
              </div>

              <div>
                <label className="settings-checkbox">
                  <input
                    type="checkbox"
                    checked={globalForm.prMergeMode}
                    onChange={(e) =>
                      setGlobalForm({ ...globalForm, prMergeMode: e.target.checked })
                    }
                  />
                  <span>PR merge mode</span>
                </label>
                <p className="settings-desc">
                  Require Pull Requests for merging code. Disabling allows direct pushes when
                  collaboration mode is "auto".
                </p>
              </div>

              <div>
                <label className="settings-checkbox">
                  <input
                    type="checkbox"
                    checked={globalForm.pushGate}
                    onChange={(e) => setGlobalForm({ ...globalForm, pushGate: e.target.checked })}
                  />
                  <span>Push gate</span>
                </label>
                <p className="settings-desc">
                  Prevent git push commands unless explicitly allowed or required by a skill.
                </p>
              </div>

              <div>
                <label className="settings-checkbox">
                  <input
                    type="checkbox"
                    checked={globalForm.sandboxedEdits}
                    onChange={(e) =>
                      setGlobalForm({ ...globalForm, sandboxedEdits: e.target.checked })
                    }
                  />
                  <span>Sandboxed edits</span>
                </label>
                <p className="settings-desc">
                  Restrict file write operations to the current project directory only.
                </p>
              </div>

              <div>
                <label className="settings-checkbox">
                  <input
                    type="checkbox"
                    checked={globalForm.gitStatusGate}
                    onChange={(e) =>
                      setGlobalForm({ ...globalForm, gitStatusGate: e.target.checked })
                    }
                  />
                  <span>Git status gate</span>
                </label>
                <p className="settings-desc">
                  Block session completion when uncommitted or unpushed git changes are detected.
                </p>
              </div>

              <div>
                <label className="settings-checkbox">
                  <input
                    type="checkbox"
                    checked={globalForm.updateMemoryFooter}
                    onChange={(e) =>
                      setGlobalForm({ ...globalForm, updateMemoryFooter: e.target.checked })
                    }
                  />
                  <span>Update memory footer</span>
                </label>
                <p className="settings-desc">
                  Require updating CLAUDE.md memory when the session completes successfully.
                </p>
              </div>

              <div>
                <label className="settings-checkbox">
                  <input
                    type="checkbox"
                    checked={globalForm.nonDefaultBranchGate}
                    onChange={(e) =>
                      setGlobalForm({ ...globalForm, nonDefaultBranchGate: e.target.checked })
                    }
                  />
                  <span>Non-default branch gate</span>
                </label>
                <p className="settings-desc">
                  Block completion on the default branch to encourage feature branch workflows.
                </p>
              </div>

              <div>
                <label className="settings-checkbox">
                  <input
                    type="checkbox"
                    checked={globalForm.githubCiGate}
                    onChange={(e) =>
                      setGlobalForm({ ...globalForm, githubCiGate: e.target.checked })
                    }
                  />
                  <span>GitHub CI gate</span>
                </label>
                <p className="settings-desc">
                  Block completion if GitHub Actions CI checks are failing.
                </p>
              </div>

              <div>
                <label className="settings-checkbox">
                  <input
                    type="checkbox"
                    checked={globalForm.changesRequestedGate}
                    onChange={(e) =>
                      setGlobalForm({ ...globalForm, changesRequestedGate: e.target.checked })
                    }
                  />
                  <span>Changes requested gate</span>
                </label>
                <p className="settings-desc">
                  Block completion if the PR has a Changes Requested review state.
                </p>
              </div>

              <div>
                <label className="settings-checkbox">
                  <input
                    type="checkbox"
                    checked={globalForm.personalRepoIssuesGate}
                    onChange={(e) =>
                      setGlobalForm({ ...globalForm, personalRepoIssuesGate: e.target.checked })
                    }
                  />
                  <span>Personal repo issues gate</span>
                </label>
                <p className="settings-desc">
                  Suggest working on open issues in personal repositories upon completion.
                </p>
              </div>

              <div>
                <label className="settings-checkbox">
                  <input
                    type="checkbox"
                    checked={globalForm.speak}
                    onChange={(e) => setGlobalForm({ ...globalForm, speak: e.target.checked })}
                  />
                  <span>Speak</span>
                </label>
                <p className="settings-desc">
                  Enable text-to-speech audio narration of certain notifications and events.
                </p>
              </div>
            </div>
          </div>

          {/* Project Column */}
          <div className="settings-column">
            <h3 className="settings-column-title">Project Settings</h3>

            {!cwd ? (
              <p className="metric-note" style={{ marginTop: "1rem" }}>
                Select a project to edit project-specific settings.
              </p>
            ) : projectLoading && !projectBaseline.collaborationMode ? (
              <p className="metric-note" style={{ marginTop: "1rem" }}>
                Loading project settings...
              </p>
            ) : (
              <div className="settings-fields">
                <label className="settings-label" htmlFor="project-ambition-mode">
                  <span>Ambition mode override</span>
                  <p className="settings-desc">
                    Project-specific override for the agent's operational tempo. "inherit" uses the
                    global setting.
                  </p>
                  <Select
                    id="project-ambition-mode"
                    value={projectForm.ambitionMode}
                    onChange={(event) => {
                      const value = event.target.value as ProjectSettingsForm["ambitionMode"]
                      setProjectForm((prev) => ({ ...prev, ambitionMode: value }))
                    }}
                    options={[
                      { label: "inherit (global)", value: "inherit" },
                      { label: "standard", value: "standard" },
                      { label: "aggressive", value: "aggressive" },
                      { label: "creative", value: "creative" },
                      { label: "reflective", value: "reflective" },
                    ]}
                  />
                </label>

                <label className="settings-label" htmlFor="project-collaboration-mode">
                  <span>Collaboration mode</span>
                  <p className="settings-desc">
                    Determines how code is integrated. "Auto" falls back to PR merge mode. "Solo"
                    pushes directly to main. "Team" and "Relaxed-collab" require PRs.
                  </p>
                  <Select
                    id="project-collaboration-mode"
                    value={projectForm.collaborationMode}
                    onChange={(event) => {
                      const value = event.target.value as ProjectSettingsForm["collaborationMode"]
                      setProjectForm((prev) => ({ ...prev, collaborationMode: value }))
                    }}
                    options={[
                      { label: "auto", value: "auto" },
                      { label: "solo", value: "solo" },
                      { label: "team", value: "team" },
                      { label: "relaxed-collab", value: "relaxed-collab" },
                    ]}
                  />
                </label>

                <div className="settings-grid-cols-2">
                  <label className="settings-label">
                    <span>Default branch</span>
                    <input
                      type="text"
                      className="settings-input"
                      value={projectForm.defaultBranch}
                      onChange={(e) =>
                        setProjectForm((prev) => ({ ...prev, defaultBranch: e.target.value }))
                      }
                    />
                  </label>
                  <label className="settings-label">
                    <span>Task duration warning (min)</span>
                    <input
                      type="number"
                      className="settings-input"
                      value={projectForm.taskDurationWarningMinutes}
                      onChange={(e) =>
                        setProjectForm((prev) => ({
                          ...prev,
                          taskDurationWarningMinutes:
                            e.target.value === "" ? "" : Number(e.target.value),
                        }))
                      }
                      placeholder="Inherit global"
                    />
                  </label>
                  <label className="settings-label">
                    <span>Trivial max files</span>
                    <input
                      type="number"
                      className="settings-input"
                      value={projectForm.trivialMaxFiles}
                      onChange={(e) =>
                        setProjectForm((prev) => ({
                          ...prev,
                          trivialMaxFiles: Number(e.target.value),
                        }))
                      }
                    />
                  </label>
                  <label className="settings-label">
                    <span>Trivial max lines</span>
                    <input
                      type="number"
                      className="settings-input"
                      value={projectForm.trivialMaxLines}
                      onChange={(e) =>
                        setProjectForm((prev) => ({
                          ...prev,
                          trivialMaxLines: Number(e.target.value),
                        }))
                      }
                    />
                  </label>
                  <label className="settings-label">
                    <span>Memory line threshold</span>
                    <input
                      type="number"
                      className="settings-input"
                      value={projectForm.memoryLineThreshold}
                      onChange={(e) =>
                        setProjectForm((prev) => ({
                          ...prev,
                          memoryLineThreshold: e.target.value === "" ? "" : Number(e.target.value),
                        }))
                      }
                      placeholder="Inherit global"
                    />
                  </label>
                  <label className="settings-label">
                    <span>Memory word threshold</span>
                    <input
                      type="number"
                      className="settings-input"
                      value={projectForm.memoryWordThreshold}
                      onChange={(e) =>
                        setProjectForm((prev) => ({
                          ...prev,
                          memoryWordThreshold: e.target.value === "" ? "" : Number(e.target.value),
                        }))
                      }
                      placeholder="Inherit global"
                    />
                  </label>
                  <label className="settings-label">
                    <span>Large file size (KB)</span>
                    <input
                      type="number"
                      className="settings-input"
                      value={projectForm.largeFileSizeKb}
                      onChange={(e) =>
                        setProjectForm((prev) => ({
                          ...prev,
                          largeFileSizeKb: e.target.value === "" ? "" : Number(e.target.value),
                        }))
                      }
                      placeholder="Inherit global"
                    />
                  </label>
                </div>

                <div>
                  <label className="settings-checkbox">
                    <input
                      type="checkbox"
                      checked={projectForm.prMergeMode}
                      onChange={(event) => {
                        setProjectForm((prev) => ({ ...prev, prMergeMode: event.target.checked }))
                      }}
                    />
                    <span>PR merge mode (Global fallback)</span>
                  </label>
                  <p className="settings-desc">
                    When Collaboration Mode is set to "Auto", this global toggle determines if pull
                    requests are required.
                  </p>
                </div>

                <div>
                  <label className="settings-checkbox">
                    <input
                      type="checkbox"
                      checked={projectForm.strictNoDirectMain}
                      onChange={(event) => {
                        setProjectForm((prev) => ({
                          ...prev,
                          strictNoDirectMain: event.target.checked,
                        }))
                      }}
                    />
                    <span>Strict merge to main mode</span>
                  </label>
                  <p className="settings-desc">
                    Enforces feature-branch workflows by blocking direct pushes to the main branch
                    locally, even in solo repositories.
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}
