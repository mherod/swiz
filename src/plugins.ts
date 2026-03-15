/**
 * Plugin loader — resolves external hook bundles from .swiz/config.json plugins list.
 * Each plugin exports HookGroup[] from a swiz-hooks.ts or swiz-hooks.json entry point.
 */

import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { dirname, isAbsolute, join, resolve } from "node:path"
import type { HookGroup } from "./manifest.ts"
import { joinNodeModulesPath } from "./node-modules-path.ts"

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
        error: `Failed to load ${tsPath}: ${normalizeError(err)}`,
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
        error: `Failed to load ${jsonPath}: ${normalizeError(err)}`,
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
    const candidate = joinNodeModulesPath(dir, name)
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

/** Truncate a string and flag if it was shortened. */
function truncate(value: string, maxLen: number): { text: string; truncated: boolean } {
  if (value.length <= maxLen) return { text: value, truncated: false }
  return { text: value.slice(0, maxLen), truncated: true }
}

/**
 * Coerce an unknown thrown value into a safe, bounded string.
 * Used for the flat `error` field on PluginResult (stderr output).
 */
function normalizeError(value: unknown, maxLen = 1024): string {
  const s = structuredError(value, maxLen)
  return s.truncated ? `${s.message}…` : s.message
}

/** Structured error detail for JSON serialization. */
export interface PluginErrorDetail {
  name?: string
  message: string
  code?: string
  cause?: string
  stack?: string
  truncated: boolean
}

/**
 * Extract structured error fields from an unknown thrown value.
 * Handles Error instances, plain strings, objects with circular refs,
 * and applies a length bound to message and stack.
 */
function extractErrorCode(err: Error): string | undefined {
  return "code" in err && (err as { code?: unknown }).code != null
    ? String((err as { code?: unknown }).code)
    : undefined
}

function isAnyTruncated(
  msg: { truncated: boolean },
  stk?: { truncated: boolean },
  causeStr?: { truncated: boolean }
): boolean {
  return msg.truncated || (stk?.truncated ?? false) || (causeStr?.truncated ?? false)
}

function structuredErrorFromError(err: Error, maxLen: number): PluginErrorDetail {
  const msg = truncate(err.message, maxLen)
  const stk = err.stack ? truncate(err.stack, maxLen) : undefined
  const causeStr = err.cause != null ? safeStringify(err.cause, maxLen) : undefined
  const code = extractErrorCode(err)

  return {
    name: err.name !== "Error" ? err.name : undefined,
    message: msg.text,
    ...(code != null ? { code } : {}),
    ...(causeStr != null ? { cause: causeStr.text } : {}),
    ...(stk != null ? { stack: stk.text } : {}),
    truncated: isAnyTruncated(msg, stk, causeStr),
  }
}

function structuredError(value: unknown, maxLen = 1024): PluginErrorDetail {
  if (value === null || value === undefined) {
    return { message: "unknown error", truncated: false }
  }
  if (value instanceof Error) return structuredErrorFromError(value, maxLen)
  const t = typeof value === "string" ? truncate(value, maxLen) : safeStringify(value, maxLen)
  return { message: t.text, truncated: t.truncated }
}

/** JSON.stringify with circular-ref safety and length bound. */
function safeStringify(value: unknown, maxLen: number): { text: string; truncated: boolean } {
  try {
    return truncate(JSON.stringify(value), maxLen)
  } catch {
    return truncate(String(value), maxLen)
  }
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
export function pluginResultsToJson(results: PluginResult[]): {
  name: string
  ok: boolean
  hookCount: number
  errorCode?: string
  hint?: string
  /** Flat error message string (backward-compatible). */
  error?: string
  /** Structured error detail with name/code/cause/stack/truncated. */
  errorDetail?: PluginErrorDetail
}[] {
  return results.map((r) => ({
    name: r.name,
    ok: !r.errorCode,
    hookCount: r.hooks.reduce((n, g) => n + g.hooks.length, 0),
    ...(r.errorCode
      ? {
          errorCode: r.errorCode,
          hint: pluginErrorHint(r.errorCode),
          error: normalizeError(r.error),
          errorDetail: structuredError(r.error),
        }
      : {}),
  }))
}

/**
 * Load all plugins from the project config and return their hooks
 * along with load status for each plugin.
 *
 * This function is side-effect-free — it returns PluginResult objects
 * with errorCode/error fields for callers to handle. Callers decide
 * their own logging strategy (e.g. dispatch uses its own log(),
 * install uses colored output, hooks formats a table).
 */
export async function loadAllPlugins(
  plugins: string[],
  projectRoot: string
): Promise<PluginResult[]> {
  return Promise.all(plugins.map((entry) => loadPlugin(entry, projectRoot)))
}
