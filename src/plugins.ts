/**
 * Plugin loader — resolves external hook bundles from .swiz/config.json plugins list.
 * Each plugin exports HookGroup[] from a swiz-hooks.ts or swiz-hooks.json entry point.
 */

import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { dirname, isAbsolute, join, resolve } from "node:path"
import type { HookGroup } from "./manifest.ts"

export interface PluginResult {
  name: string
  hooks: HookGroup[]
  error?: string
}

/**
 * Resolve and load hook groups from a single plugin entry.
 * Supports:
 *   - Local paths (relative to projectRoot): "./company-hooks"
 *   - npm package names: "swiz-plugin-security"
 */
async function loadPlugin(entry: string, projectRoot: string): Promise<PluginResult> {
  const isLocal = entry.startsWith("./") || entry.startsWith("../") || isAbsolute(entry)
  const base = isLocal ? resolve(projectRoot, entry) : findNodeModulesPlugin(entry, projectRoot)

  if (!base) {
    return { name: entry, hooks: [], error: `Plugin not found: ${entry}` }
  }

  // Try swiz-hooks.ts first (ESM import), then swiz-hooks.json
  const tsPath = join(base, "swiz-hooks.ts")
  const jsonPath = join(base, "swiz-hooks.json")

  if (existsSync(tsPath)) {
    try {
      const mod = await import(tsPath)
      const hooks = (mod.hooks ?? mod.default) as HookGroup[] | undefined
      if (!Array.isArray(hooks)) {
        return { name: entry, hooks: [], error: `${tsPath} does not export hooks: HookGroup[]` }
      }
      return { name: entry, hooks: resolveHookPaths(hooks, base) }
    } catch (err) {
      return { name: entry, hooks: [], error: `Failed to load ${tsPath}: ${String(err)}` }
    }
  }

  if (existsSync(jsonPath)) {
    try {
      const raw = await readFile(jsonPath, "utf-8")
      const hooks = JSON.parse(raw) as HookGroup[]
      if (!Array.isArray(hooks)) {
        return { name: entry, hooks: [], error: `${jsonPath} is not a HookGroup[]` }
      }
      return { name: entry, hooks: resolveHookPaths(hooks, base) }
    } catch (err) {
      return { name: entry, hooks: [], error: `Failed to load ${jsonPath}: ${String(err)}` }
    }
  }

  return { name: entry, hooks: [], error: `No swiz-hooks.ts or swiz-hooks.json found in ${base}` }
}

/** Walk up from projectRoot looking for node_modules/<name> */
function findNodeModulesPlugin(name: string, projectRoot: string): string | null {
  let dir = projectRoot
  while (true) {
    const candidate = join(dir, "node_modules", name)
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/** Make hook file paths absolute relative to the plugin directory */
function resolveHookPaths(groups: HookGroup[], pluginDir: string): HookGroup[] {
  return groups.map((g) => ({
    ...g,
    hooks: g.hooks.map((h) => ({
      ...h,
      file: isAbsolute(h.file) ? h.file : join(pluginDir, h.file),
    })),
  }))
}

export interface LoadPluginsOptions {
  /** When true, log plugin errors to stderr. Use for install/status flows. */
  verbose?: boolean
}

/**
 * Load all plugins from the project config and return their hooks
 * along with load status for each plugin.
 *
 * Error visibility policy:
 * - verbose=true  → logs full errors to stderr (install, hooks commands)
 * - verbose=false → silent; callers inspect result.error
 * Dispatch emits brief stderr warnings for failures and logs details to the
 * debug log (/tmp/swiz-dispatch.log).
 */
export async function loadAllPlugins(
  plugins: string[],
  projectRoot: string,
  options?: LoadPluginsOptions
): Promise<PluginResult[]> {
  const verbose = options?.verbose ?? false
  const results: PluginResult[] = []
  for (const entry of plugins) {
    const result = await loadPlugin(entry, projectRoot)
    if (result.error && verbose) {
      console.error(`[swiz] Warning: plugin ${result.name}: ${result.error}`)
    }
    results.push(result)
  }
  return results
}
