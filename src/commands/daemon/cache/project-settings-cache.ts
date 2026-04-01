import type { HookGroup } from "../../../manifest.ts"
import {
  type ProjectSwizSettings,
  readProjectSettings,
  resolveProjectHooks,
} from "../../../settings.ts"
import { CappedMap } from "./capped-map.ts"

export interface CachedProjectSettings {
  settings: ProjectSwizSettings | null
  resolvedHooks: HookGroup[]
  warnings: string[]
  cachedAt: number
}

export class ProjectSettingsCache {
  private entries = new CappedMap<string, CachedProjectSettings>(200)
  private inFlight = new Map<string, Promise<CachedProjectSettings>>()

  async get(cwd: string): Promise<CachedProjectSettings> {
    const cached = this.entries.get(cwd)
    if (cached) return cached
    const inflight = this.inFlight.get(cwd)
    if (inflight) return inflight
    const computation = readProjectSettings(cwd).then((settings) => {
      this.inFlight.delete(cwd)
      let resolvedHooks: HookGroup[] = []
      let warnings: string[] = []
      if (settings?.hooks?.length) {
        const result = resolveProjectHooks(settings.hooks, cwd)
        resolvedHooks = result.resolved
        warnings = result.warnings
      }
      const entry: CachedProjectSettings = {
        settings,
        resolvedHooks,
        warnings,
        cachedAt: Date.now(),
      }
      this.entries.set(cwd, entry)
      return entry
    })
    this.inFlight.set(cwd, computation)
    return computation
  }

  invalidateProject(cwd: string): void {
    this.entries.delete(cwd)
  }

  invalidateAll(): void {
    this.entries.clear()
  }

  get size(): number {
    return this.entries.size
  }
}
