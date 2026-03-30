/**
 * Shared types, constants, and utilities for dispatch workers and engine.
 * Imported by hook-worker.ts, worker-pool.ts, and engine.ts.
 */

import { join } from "node:path"
import { hookOutputSchema } from "../../hooks/schemas.ts"

// ─── Shared constants ──────────────────────────────────────────────────────

export const HOOKS_DIR = join(import.meta.dir, "..", "..", "hooks")
export const DEFAULT_TIMEOUT = 10 // seconds
/** Grace period before escalating SIGTERM → SIGKILL on timed-out hooks (ms). */
export const SIGKILL_GRACE_MS = 3_000

// ─── Message types ─────────────────────────────────────────────────────────

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

// ─── Hook output classification ────────────────────────────────────────────

/**
 * Validate parsed hook output against the hook output schema.
 * Returns { valid: true } if schema passes, or { valid: false, error: string } if validation fails.
 * This is the earliest point to catch schema violations (e.g., silent allow without context).
 */
function validateHookOutputSchema(
  parsed: Record<string, unknown>
): { valid: true } | { valid: false; error: string } {
  const result = hookOutputSchema.safeParse(parsed)
  if (result.success) {
    return { valid: true }
  }
  // Extract the first validation error for clarity
  const firstIssue = result.error.issues[0]
  const errorMsg = firstIssue?.message ?? "Unknown schema validation error"
  return { valid: false, error: errorMsg }
}

/**
 * Pure classification of raw hook output into a status and parsed JSON.
 * Shared between engine.ts (main thread) and hook-worker.ts (worker thread).
 *
 * Validates parsed JSON against the hook output schema to catch violations
 * (e.g., allow without context) at the earliest point.
 */
export function classifyHookOutput({
  timedOut,
  trimmed,
  exitCode,
}: {
  timedOut: boolean
  trimmed: string
  exitCode: number | null
}): { parsed: Record<string, unknown> | null; status: string } {
  if (timedOut) return { parsed: null, status: "timeout" }
  if (!trimmed) return { parsed: null, status: exitCode !== 0 ? "error" : "no-output" }

  let parsed: Record<string, unknown> | null = null
  try {
    parsed = JSON.parse(trimmed) as Record<string, unknown>
  } catch {
    // Stdout may contain non-JSON lines before or after the hook's JSON object.
    // Scan lines in reverse order so the last JSON-looking line wins.
    for (const line of trimmed.split("\n").reverse()) {
      const l = line.trim()
      if (!l.startsWith("{")) continue
      try {
        parsed = JSON.parse(l) as Record<string, unknown>
        break
      } catch {
        // Fall through to next line
      }
    }
    if (!parsed) {
      return { parsed: null, status: "invalid-json" }
    }
  }

  // Validate against schema
  const validation = validateHookOutputSchema(parsed)
  if (!validation.valid) {
    return { parsed, status: "invalid-schema" }
  }

  return { parsed, status: "ok" }
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
