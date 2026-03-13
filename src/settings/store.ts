import {
  getProjectSettingsPath,
  getSwizSettingsPath,
  type ReadOptions,
  readProjectSettings,
  readSwizSettings,
  type WriteOptions,
  writeProjectSettings,
  writeSwizSettings,
} from "./persistence"
import { getEffectiveSwizSettings } from "./resolution"
import type { EffectiveSwizSettings, ProjectSwizSettings, SwizSettings } from "./types"

/**
 * Centralised settings store — owns all read/merge/write logic for global,
 * project, and session scopes.  Callers should use SettingsStore methods
 * instead of calling read/write primitives directly.
 */
export class SettingsStore {
  private readonly options: ReadOptions & WriteOptions

  constructor(options: ReadOptions & WriteOptions = {}) {
    this.options = options
  }

  // ── Readers ──────────────────────────────────────────────────────────────

  async readGlobal(): Promise<SwizSettings> {
    return readSwizSettings(this.options)
  }

  async readProject(cwd: string): Promise<ProjectSwizSettings | null> {
    return readProjectSettings(cwd)
  }

  async effective(cwd: string, sessionId?: string | null): Promise<EffectiveSwizSettings> {
    const [global, project] = await Promise.all([this.readGlobal(), this.readProject(cwd)])
    return getEffectiveSwizSettings(global, sessionId, project)
  }

  // ── Mutators ─────────────────────────────────────────────────────────────

  /**
   * Set a single key in global settings.
   * Returns the path that was written.
   */
  async setGlobal(key: string, value: unknown): Promise<string> {
    const current = await readSwizSettings({ ...this.options, strict: true })
    return writeSwizSettings({ ...current, [key]: value }, this.options)
  }

  /**
   * Set a single key in project settings.
   * Returns the path that was written.
   */
  async setProject(cwd: string, key: string, value: unknown): Promise<string> {
    return writeProjectSettings(cwd, { [key]: value })
  }

  /**
   * Set a single key in a specific session's settings.
   * Returns the path that was written.
   */
  async setSession(sessionId: string, key: string, value: unknown): Promise<string> {
    const current = await readSwizSettings({ ...this.options, strict: true })
    return writeSwizSettings(
      {
        ...current,
        sessions: {
          ...current.sessions,
          [sessionId]: {
            ...(current.sessions[sessionId] ?? { autoContinue: current.autoContinue }),
            [key]: value,
          },
        },
      },
      this.options
    )
  }

  /**
   * Add a hook filename to the disabled list for the given scope.
   * Returns { path, alreadyDisabled }.
   */
  async disableHook(
    scope: "global" | "project",
    filename: string,
    cwd?: string
  ): Promise<{ path: string; alreadyDisabled: boolean }> {
    if (scope === "project") {
      if (!cwd) throw new Error("cwd required for project scope")
      const project = await readProjectSettings(cwd)
      const existing = project?.disabledHooks ?? []
      if (existing.includes(filename))
        return { path: getProjectSettingsPath(cwd), alreadyDisabled: true }
      const path = await writeProjectSettings(cwd, { disabledHooks: [...existing, filename] })
      return { path, alreadyDisabled: false }
    }
    const current = await readSwizSettings({ ...this.options, strict: true })
    const existing = current.disabledHooks ?? []
    if (existing.includes(filename)) {
      return { path: getSwizSettingsPath(this.options.home) ?? "", alreadyDisabled: true }
    }
    const path = await writeSwizSettings(
      { ...current, disabledHooks: [...existing, filename] },
      this.options
    )
    return { path, alreadyDisabled: false }
  }

  /**
   * Remove a hook filename from the disabled list for the given scope.
   * Returns { path, wasEnabled }.
   */
  async enableHook(
    scope: "global" | "project",
    filename: string,
    cwd?: string
  ): Promise<{ path: string; wasEnabled: boolean }> {
    if (scope === "project") {
      if (!cwd) throw new Error("cwd required for project scope")
      const project = await readProjectSettings(cwd)
      const existing = project?.disabledHooks ?? []
      if (!existing.includes(filename))
        return { path: getProjectSettingsPath(cwd), wasEnabled: false }
      const path = await writeProjectSettings(cwd, {
        disabledHooks: existing.filter((f) => f !== filename),
      })
      return { path, wasEnabled: true }
    }
    const current = await readSwizSettings({ ...this.options, strict: true })
    const existing = current.disabledHooks ?? []
    if (!existing.includes(filename)) {
      return { path: getSwizSettingsPath(this.options.home) ?? "", wasEnabled: false }
    }
    const path = await writeSwizSettings(
      { ...current, disabledHooks: existing.filter((f) => f !== filename) },
      this.options
    )
    return { path, wasEnabled: true }
  }
}

/** Shared default store instance — used by commands that don't need custom options. */
export const settingsStore = new SettingsStore()
