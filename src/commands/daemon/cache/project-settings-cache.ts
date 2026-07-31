import type { HookGroup } from "../../../manifest.ts"
import {
  type ProjectSwizSettings,
  readProjectSettings,
  resolveProjectHooks,
} from "../../../settings.ts"
import { KeyedAsyncCache } from "../../../utils/keyed-async-cache.ts"

export interface CachedProjectSettings {
  settings: ProjectSwizSettings | null
  resolvedHooks: HookGroup[]
  warnings: string[]
  cachedAt: number
}

/**
 * Per-project `.swiz` settings and their resolved hook groups.
 *
 * Entries live until the daemon invalidates them on a settings change, so no TTL
 * is configured.
 */
export class ProjectSettingsCache {
  private readonly cache = new KeyedAsyncCache<CachedProjectSettings>()

  get(cwd: string): Promise<CachedProjectSettings> {
    return this.cache.get(cwd, async (dir) => {
      const settings = await readProjectSettings(dir)
      let resolvedHooks: HookGroup[] = []
      let warnings: string[] = []
      if (settings?.hooks?.length) {
        const result = resolveProjectHooks(settings.hooks, dir)
        resolvedHooks = result.resolved
        warnings = result.warnings
      }
      return { settings, resolvedHooks, warnings, cachedAt: Date.now() }
    })
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
