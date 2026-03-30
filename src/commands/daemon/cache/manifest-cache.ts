import type { HookGroup } from "../../../manifest.ts"
import type { ProjectSettingsCache } from "./project-settings-cache.ts"

export interface CachedManifest {
  groups: HookGroup[]
  cachedAt: number
}

export class ManifestCache {
  private entries = new Map<string, CachedManifest>()
  private inFlight = new Map<string, Promise<HookGroup[]>>()
  private projectSettingsCache: ProjectSettingsCache

  constructor(projectSettingsCache: ProjectSettingsCache) {
    this.projectSettingsCache = projectSettingsCache
  }

  async get(cwd: string): Promise<HookGroup[]> {
    const cached = this.entries.get(cwd)
    if (cached) return cached.groups
    const inflight = this.inFlight.get(cwd)
    if (inflight) return inflight
    const computation = this.build(cwd).then((groups) => {
      this.entries.set(cwd, { groups, cachedAt: Date.now() })
      this.inFlight.delete(cwd)
      return groups
    })
    this.inFlight.set(cwd, computation)
    return computation
  }

  private async build(cwd: string): Promise<HookGroup[]> {
    const { manifest: builtinManifest } = await import("../../../manifest.ts")
    const { loadAllPlugins } = await import("../../../plugins.ts")
    let combined: HookGroup[] = [...builtinManifest]
    const cachedSettings = await this.projectSettingsCache.get(cwd)
    const projectSettings = cachedSettings.settings
    if (projectSettings?.plugins?.length) {
      const pluginResults = await loadAllPlugins(projectSettings.plugins, cwd)
      const pluginHooks = pluginResults.flatMap((r) => r.hooks)
      if (pluginHooks.length > 0) combined = [...combined, ...pluginHooks]
    }
    if (cachedSettings.resolvedHooks.length > 0) {
      combined = [...combined, ...cachedSettings.resolvedHooks]
    }
    return combined
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
