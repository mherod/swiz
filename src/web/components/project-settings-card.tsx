import { useEffect, useMemo, useState } from "react"
import { postJson } from "../lib/http.ts"

interface CachedProjectSettingsResponse {
  settings?: {
    collaborationMode?: "auto" | "solo" | "team" | "relaxed-collab"
    strictNoDirectMain?: boolean
  } | null
  globalSettings?: {
    prMergeMode?: boolean
  } | null
}

interface ProjectSettingsForm {
  collaborationMode: "auto" | "solo" | "team" | "relaxed-collab"
  prMergeMode: boolean
  strictNoDirectMain: boolean
}

const DEFAULT_FORM: ProjectSettingsForm = {
  collaborationMode: "auto",
  prMergeMode: true,
  strictNoDirectMain: false,
}

function settingsToForm(response: CachedProjectSettingsResponse): ProjectSettingsForm {
  const settings = response.settings
  const globalSettings = response.globalSettings
  return {
    collaborationMode: settings?.collaborationMode ?? "auto",
    prMergeMode: globalSettings?.prMergeMode ?? true,
    strictNoDirectMain: settings?.strictNoDirectMain ?? false,
  }
}

function isDirty(form: ProjectSettingsForm, baseline: ProjectSettingsForm): boolean {
  return (
    form.collaborationMode !== baseline.collaborationMode ||
    form.prMergeMode !== baseline.prMergeMode ||
    form.strictNoDirectMain !== baseline.strictNoDirectMain
  )
}

export function ProjectSettingsCard({ cwd }: { cwd: string | null }) {
  const [form, setForm] = useState<ProjectSettingsForm>(DEFAULT_FORM)
  const [baseline, setBaseline] = useState<ProjectSettingsForm>(DEFAULT_FORM)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const [status, setStatus] = useState("")

  useEffect(() => {
    if (!cwd) {
      setForm(DEFAULT_FORM)
      setBaseline(DEFAULT_FORM)
      setError("")
      setStatus("")
      return
    }
    let cancelled = false
    setLoading(true)
    setError("")
    setStatus("")
    void postJson<CachedProjectSettingsResponse>("/settings/project", { cwd })
      .then((result) => {
        if (cancelled) return
        const next = settingsToForm(result)
        setForm(next)
        setBaseline(next)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : "Failed to load settings")
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [cwd])

  const dirty = useMemo(() => isDirty(form, baseline), [form, baseline])

  const saveDisabled = !cwd || loading || saving || !dirty

  return (
    <section className="card panel-settings">
      <h2 className="section-title">Project settings</h2>
      <p className="section-subtitle">Set key behavior for the selected project</p>

      {!cwd ? (
        <p className="metric-note">Select a project to edit settings.</p>
      ) : (
        <form
          className="settings-form"
          onSubmit={(event) => {
            event.preventDefault()
            if (!cwd || saveDisabled) return
            setSaving(true)
            setError("")
            setStatus("")
            void postJson<CachedProjectSettingsResponse>("/settings/project/update", {
              cwd,
              updates: {
                collaborationMode: form.collaborationMode,
                prMergeMode: form.prMergeMode,
                strictNoDirectMain: form.strictNoDirectMain,
              },
            })
              .then((result) => {
                const next = settingsToForm(result)
                setForm(next)
                setBaseline(next)
                setStatus("Saved")
              })
              .catch((err) => {
                setError(err instanceof Error ? err.message : "Failed to save settings")
              })
              .finally(() => {
                setSaving(false)
              })
          }}
        >
          <label className="settings-label">
            <span>Collaboration mode</span>
            <p className="settings-desc">
              Determines how code is integrated. "Auto" falls back to PR merge mode. "Solo" pushes
              directly to main. "Team" and "Relaxed-collab" require PRs.
            </p>
            <select
              className="settings-select"
              value={form.collaborationMode}
              onChange={(event) => {
                const value = event.target.value as ProjectSettingsForm["collaborationMode"]
                setForm((prev) => ({ ...prev, collaborationMode: value }))
              }}
            >
              <option value="auto">auto</option>
              <option value="solo">solo</option>
              <option value="team">team</option>
              <option value="relaxed-collab">relaxed-collab</option>
            </select>
          </label>

          <label className="settings-checkbox">
            <input
              type="checkbox"
              checked={form.prMergeMode}
              onChange={(event) => {
                setForm((prev) => ({ ...prev, prMergeMode: event.target.checked }))
              }}
            />
            <span>PR merge mode (Global fallback)</span>
          </label>
          <p className="settings-desc">
            When Collaboration Mode is set to "Auto", this global toggle determines if pull requests
            are required.
          </p>

          <label className="settings-checkbox">
            <input
              type="checkbox"
              checked={form.strictNoDirectMain}
              onChange={(event) => {
                setForm((prev) => ({ ...prev, strictNoDirectMain: event.target.checked }))
              }}
            />
            <span>Strict merge to main mode</span>
          </label>
          <p className="settings-desc" style={{ marginBottom: "16px" }}>
            Enforces feature-branch workflows by blocking direct pushes to the main branch locally,
            even in solo repositories.
          </p>

          <div className="settings-actions">
            <button className="settings-save-btn" type="submit" disabled={saveDisabled}>
              {saving ? "Saving..." : "Save settings"}
            </button>
            {status ? <span className="settings-status-ok">{status}</span> : null}
          </div>
          {error ? <p className="settings-status-error">{error}</p> : null}
        </form>
      )}
    </section>
  )
}
