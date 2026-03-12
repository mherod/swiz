import { useEffect, useMemo, useState } from "react"
import { postJson } from "../lib/http.ts"

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
}

const DEFAULT_FORM: GlobalSettingsForm = {
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
}

function settingsToForm(settings: Record<string, unknown>): GlobalSettingsForm {
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
  }
}

function isDirty(form: GlobalSettingsForm, baseline: GlobalSettingsForm): boolean {
  return JSON.stringify(form) !== JSON.stringify(baseline)
}

export function GlobalSettingsCard() {
  const [form, setForm] = useState<GlobalSettingsForm>(DEFAULT_FORM)
  const [baseline, setBaseline] = useState<GlobalSettingsForm>(DEFAULT_FORM)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const [status, setStatus] = useState("")

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError("")
    setStatus("")
    fetch("/settings/global")
      .then((res) => {
        if (!res.ok) throw new Error("Network response was not ok")
        return res.json()
      })
      .then((result) => {
        if (cancelled) return
        const next = settingsToForm(result.settings || {})
        setForm(next)
        setBaseline(next)
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

  const dirty = useMemo(() => isDirty(form, baseline), [form, baseline])

  const saveDisabled = loading || saving || !dirty

  return (
    <section className="card panel-settings">
      <h2 className="section-title">Global settings</h2>
      <p className="section-subtitle">Set system-wide swiz behavior</p>

      <form
        className="settings-form"
        onSubmit={(event) => {
          event.preventDefault()
          if (saveDisabled) return
          setSaving(true)
          setError("")
          setStatus("")

          const updates: Record<string, unknown> = {}
          for (const key of Object.keys(form) as Array<keyof GlobalSettingsForm>) {
            if (form[key] !== baseline[key]) {
              updates[key] = form[key]
            }
          }

          void postJson<{ success: boolean; settings: Record<string, unknown> }>(
            "/settings/global/update",
            {
              updates,
            }
          )
            .then((result) => {
              const next = settingsToForm(result.settings)
              setForm(next)
              setBaseline(next)
              setStatus("Saved")
            })
            .catch((err) => {
              setError(err instanceof Error ? err.message : "Failed to save global settings")
            })
            .finally(() => {
              setSaving(false)
            })
        }}
      >
        <div className="settings-fields">
          <div>
            <label className="settings-label">
              <span>Ambition mode</span>
              <p className="settings-desc">
                Agent's operational tempo. "standard" focuses on prompt completion. "aggressive"
                acts autonomously. "creative" focuses on exploratory design. "reflective"
                prioritizes analysis.
              </p>
              <select
                className="settings-select"
                value={form.ambitionMode}
                onChange={(e) =>
                  setForm({
                    ...form,
                    ambitionMode: e.target.value as GlobalSettingsForm["ambitionMode"],
                  })
                }
              >
                <option value="standard">standard</option>
                <option value="aggressive">aggressive</option>
                <option value="creative">creative</option>
                <option value="reflective">reflective</option>
              </select>
            </label>
          </div>

          <div className="settings-grid-cols-2">
            <label className="settings-label">
              <span>Memory line threshold</span>
              <input
                type="number"
                className="settings-input"
                value={form.memoryLineThreshold}
                onChange={(e) => setForm({ ...form, memoryLineThreshold: Number(e.target.value) })}
              />
            </label>
            <label className="settings-label">
              <span>Memory word threshold</span>
              <input
                type="number"
                className="settings-input"
                value={form.memoryWordThreshold}
                onChange={(e) => setForm({ ...form, memoryWordThreshold: Number(e.target.value) })}
              />
            </label>
          </div>

          <div>
            <label className="settings-checkbox">
              <input
                type="checkbox"
                checked={form.autoContinue}
                onChange={(e) => setForm({ ...form, autoContinue: e.target.checked })}
              />
              <span>Auto-continue</span>
            </label>
            <p className="settings-desc">
              Automatically trigger follow-up execution runs for pending tasks without user prompts.
            </p>
          </div>

          <div>
            <label className="settings-checkbox">
              <input
                type="checkbox"
                checked={form.critiquesEnabled}
                onChange={(e) => setForm({ ...form, critiquesEnabled: e.target.checked })}
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
                checked={form.prMergeMode}
                onChange={(e) => setForm({ ...form, prMergeMode: e.target.checked })}
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
                checked={form.pushGate}
                onChange={(e) => setForm({ ...form, pushGate: e.target.checked })}
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
                checked={form.sandboxedEdits}
                onChange={(e) => setForm({ ...form, sandboxedEdits: e.target.checked })}
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
                checked={form.gitStatusGate}
                onChange={(e) => setForm({ ...form, gitStatusGate: e.target.checked })}
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
                checked={form.speak}
                onChange={(e) => setForm({ ...form, speak: e.target.checked })}
              />
              <span>Speak</span>
            </label>
            <p className="settings-desc">
              Enable text-to-speech audio narration of certain notifications and events.
            </p>
          </div>
        </div>

        <div className="settings-actions">
          {error && <span className="settings-error">{error}</span>}
          {status && !error && <span className="settings-status">{status}</span>}
          <button type="submit" className="settings-save-btn" disabled={saveDisabled}>
            {saving ? "Saving..." : "Save changes"}
          </button>
        </div>
      </form>
    </section>
  )
}
