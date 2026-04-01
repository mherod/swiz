/**
 * Shared types, constants, and utilities for dispatch workers and engine.
 * Imported by hook-worker.ts, worker-pool.ts, and engine.ts.
 */

import { join } from "node:path"
import { z } from "zod"
import { hookOutputSchema } from "../../hooks/schemas.ts"
import type { HookStatus } from "./engine.ts"

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
  parsed: Record<string, any>
): { valid: true } | { valid: false; error: string } {
  try {
    hookOutputSchema.parse(parsed)
    return { valid: true }
  } catch (e) {
    if (e instanceof z.ZodError) {
      const firstIssue = e.issues[0]
      const errorMsg = firstIssue?.message ?? "Unknown schema validation error"
      return { valid: false, error: errorMsg }
    }
    return { valid: false, error: "Unknown schema validation error" }
  }
}

/**
 * Parse a JSON object substring when the full stdout string is not valid JSON
 * (prefix/suffix log lines, pretty-printed multi-line objects, etc.).
 */
function parseJsonFromPollutedStdout(trimmed: string): Record<string, any> | null {
  const fromLastBrace = tryParseJsonObjectFromLastBrace(trimmed)
  if (fromLastBrace !== null) return fromLastBrace

  const balanced = extractFirstBalancedJsonObject(trimmed)
  if (balanced !== null) {
    try {
      return JSON.parse(balanced) as Record<string, any>
    } catch {
      return null
    }
  }
  return null
}

/** Last `{` through end of string — handles prefix logs + pretty-printed JSON at the end. */
function tryParseJsonObjectFromLastBrace(trimmed: string): Record<string, any> | null {
  const lastBrace = trimmed.lastIndexOf("{")
  if (lastBrace < 0) return null
  try {
    return JSON.parse(trimmed.slice(lastBrace)) as Record<string, any>
  } catch {
    return null
  }
}

/** One character inside a JSON string literal (handles `\\` and closing `"`). */
function stepInsideJsonString(
  c: string,
  stringEscape: boolean
): { stringEscape: boolean; closeString: boolean } {
  if (stringEscape) return { stringEscape: false, closeString: false }
  if (c === "\\") return { stringEscape: true, closeString: false }
  if (c === '"') return { stringEscape: false, closeString: true }
  return { stringEscape: false, closeString: false }
}

/**
 * First balanced `{ ... }` from the first `{`, respecting string escapes.
 * Handles JSON-first stdout with trailing non-JSON lines (e.g. auth library noise).
 */
function extractFirstBalancedJsonObject(s: string): string | null {
  const start = s.indexOf("{")
  if (start < 0) return null
  let depth = 0
  let inString = false
  let stringEscape = false
  for (let i = start; i < s.length; i++) {
    const c = s[i]!
    if (inString) {
      const next = stepInsideJsonString(c, stringEscape)
      stringEscape = next.stringEscape
      if (next.closeString) inString = false
      continue
    }
    if (c === '"') {
      inString = true
      continue
    }
    if (c === "{") depth++
    else if (c === "}") {
      depth--
      if (depth === 0) return s.slice(start, i + 1)
    }
  }
  return null
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
}): { parsed: Record<string, any> | null; status: HookStatus } {
  if (timedOut) return { parsed: null, status: "timeout" }
  if (!trimmed) return { parsed: null, status: exitCode !== 0 ? "error" : "no-output" }

  let parsed: Record<string, any> | null = null
  try {
    parsed = JSON.parse(trimmed) as Record<string, any>
  } catch {
    parsed = parseJsonFromPollutedStdout(trimmed)
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
    const parsed = JSON.parse(payloadStr) as Record<string, any>
    const rawCwd = parsed.cwd
    if (typeof rawCwd === "string" && rawCwd.trim()) {
      return rawCwd.trim()
    }
  } catch {
    // malformed payload — spawn without cwd override
  }
  return undefined
}
