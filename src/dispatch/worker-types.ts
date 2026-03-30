/**
 * Shared types and utilities for dispatch workers and engine.
 * Imported by hook-worker.ts, worker-pool.ts, and engine.ts.
 */

export interface RunHookMessage {
  id: string
  type: "run-hook"
  file: string
  payloadStr: string
  timeoutSec?: number
}

export interface ErrorResult {
  id: string
  type: "hook-error"
  error: string
}

/** Extract the caller's environment from the enriched payload `_env` field.
 *  Returns null when absent (e.g. replay mode or direct CLI dispatch). */
export function extractCallerEnv(payloadStr: string): Record<string, string> | null {
  try {
    const payload = JSON.parse(payloadStr)
    const env = payload?._env
    if (env && typeof env === "object" && !Array.isArray(env)) {
      return env as Record<string, string>
    }
  } catch {
    // Malformed payload — fail open, inherit current env
  }
  return null
}

/**
 * Extract `cwd` from the hook JSON payload for `Bun.spawn({ cwd })`.
 * When set, the hook process runs with that working directory so `process.cwd()`
 * inside hooks matches the project (e.g. Cursor), not the swiz dispatch directory.
 */
export function extractPayloadCwd(payloadStr: string): string | undefined {
  try {
    const parsed = JSON.parse(payloadStr) as Record<string, unknown>
    const rawCwd = parsed.cwd
    if (typeof rawCwd === "string" && rawCwd.trim()) {
      return rawCwd.trim()
    }
  } catch {
    // malformed payload — spawn without cwd override
  }
  return undefined
}
