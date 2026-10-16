import type { ManifestCache, ProjectSettingsCache } from "./runtime-cache.ts"

/** Dependencies shared by the legacy and scoped settings endpoints. */
export interface SettingsRoutesContext {
  touchProject: (cwd: string) => void
  registerProjectWatchers: (cwd: string) => void
  projectSettingsCache: ProjectSettingsCache
  manifestCache: ManifestCache
}

/** Call after a successful project settings write, before reading the updated response. */
export function invalidateProjectSettings(ctx: SettingsRoutesContext, cwd: string): void {
  ctx.projectSettingsCache.invalidateProject(cwd)
  ctx.manifestCache.invalidateProject(cwd)
}
