import type { HookGroup } from "../../../manifest.ts"
import { KeyedAsyncCache } from "../../../utils/keyed-async-cache.ts"
import type { ProjectSettingsCache } from "./project-settings-cache.ts"

/**
 * Per-project combined hook manifest: builtins plus plugin and project-local
 * groups. Entries live until the daemon invalidates them, so no TTL is set.
 */
export class ManifestCache {
  private readonly cache = new KeyedAsyncCache<HookGroup[]>()
  private projectSettingsCache: ProjectSettingsCache

  constructor(projectSettingsCache: ProjectSettingsCache) {
    this.projectSettingsCache = projectSettingsCache
  }

  get(cwd: string): Promise<HookGroup[]> {
    return this.cache.get(cwd, (dir) => this.build(dir))
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
    this.cache.invalidate(cwd)
  }

  invalidateAll(): void {
    this.cache.invalidateAll()
  }

  get size(): number {
    return this.cache.size
  }
}
