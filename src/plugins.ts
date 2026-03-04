/**
 * Plugin loader — resolves external hook bundles from .swiz/config.json plugins list.
 * Each plugin exports HookGroup[] from a swiz-hooks.ts or swiz-hooks.json entry point.
 */

import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { dirname, isAbsolute, join, resolve } from "node:path"
import type { HookGroup } from "./manifest.ts"

export type PluginErrorCode =
  | "not-found"
  | "no-entry-point"
  | "invalid-export"
  | "parse-error"
  | "load-error"

export interface PluginResult {
  name: string
  hooks: HookGroup[]
  error?: string
  errorCode?: PluginErrorCode
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
    return { name: entry, hooks: [], errorCode: "not-found", error: `Plugin not found: ${entry}` }
  }

  // Try swiz-hooks.ts first (ESM import), then swiz-hooks.json
  const tsPath = join(base, "swiz-hooks.ts")
  const jsonPath = join(base, "swiz-hooks.json")

  if (existsSync(tsPath)) {
    try {
      const mod = await import(tsPath)
      const hooks = (mod.hooks ?? mod.default) as HookGroup[] | undefined
      if (!Array.isArray(hooks)) {
        return {
          name: entry,
          hooks: [],
          errorCode: "invalid-export",
          error: `${tsPath} does not export hooks: HookGroup[]`,
        }
      }
      return { name: entry, hooks: resolveHookPaths(hooks, base) }
    } catch (err) {
      return {
        name: entry,
        hooks: [],
        errorCode: "load-error",
        error: `Failed to load ${tsPath}: ${String(err)}`,
      }
    }
  }

  if (existsSync(jsonPath)) {
    try {
      const raw = await readFile(jsonPath, "utf-8")
      const hooks = JSON.parse(raw) as HookGroup[]
      if (!Array.isArray(hooks)) {
        return {
          name: entry,
          hooks: [],
          errorCode: "invalid-export",
          error: `${jsonPath} is not a HookGroup[]`,
        }
      }
      return { name: entry, hooks: resolveHookPaths(hooks, base) }
    } catch (err) {
      return {
        name: entry,
        hooks: [],
        errorCode: "parse-error",
        error: `Failed to load ${jsonPath}: ${String(err)}`,
      }
    }
  }

  return {
    name: entry,
    hooks: [],
    errorCode: "no-entry-point",
    error: `No swiz-hooks.ts or swiz-hooks.json found in ${base}`,
  }
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

/** Human-readable hint for a plugin error code. */
export function pluginErrorHint(code: PluginErrorCode): string {
  switch (code) {
    case "not-found":
      return "not installed"
    case "no-entry-point":
      return "missing swiz-hooks entry"
    case "invalid-export":
      return "bad export format"
    case "parse-error":
      return "invalid JSON"
    case "load-error":
      return "load failed"
  }
}

/** Serialize plugin results to a JSON-friendly array for machine consumption. */
export function pluginResultsToJson(
  results: PluginResult[]
): { name: string; ok: boolean; hookCount: number; errorCode?: string; hint?: string }[] {
  return results.map((r) => ({
    name: r.name,
    ok: !r.errorCode,
    hookCount: r.hooks.reduce((n, g) => n + g.hooks.length, 0),
    ...(r.errorCode ? { errorCode: r.errorCode, hint: pluginErrorHint(r.errorCode) } : {}),
  }))
}

export interface LoadPluginsOptions {
  /** When true, also log the full error detail to stderr. */
  verbose?: boolean
}

/**
 * Load all plugins from the project config and return their hooks
 * along with load status for each plugin.
 *
 * Error visibility policy:
 * - A brief warning is always emitted to stderr on failure so users
 *   notice broken integrations regardless of the calling context.
 * - verbose=true additionally logs the full error detail to stderr.
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
    if (result.error) {
      console.error(`[swiz] plugin ${result.name} failed to load`)
      if (verbose) {
        console.error(`[swiz]   ${result.error}`)
      }
    }
    results.push(result)
  }
  return results
}
