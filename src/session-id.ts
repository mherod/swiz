/**
 * Canonical type alias for session identifiers used across commands and hooks.
 * Keep this as `string` for interoperability with on-disk IDs and hook payloads.
 */
export type SessionId = string

/**
 * Derive a short stable prefix from a session ID for namespaced task IDs.
 * Uses first 4 characters after removing dashes and lowercasing.
 */
export function sessionPrefix(sessionId: SessionId): string {
  return sessionId.replace(/-/g, "").slice(0, 4).toLowerCase()
}

/**
 * Sanitize session IDs for use in /tmp sentinel file names.
 * Returns null when the input is missing or sanitizes to empty.
 */
export function sanitizeSessionId(sessionId: string | undefined | null): string | null {
  if (!sessionId || sessionId === "null") return null
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "")
  return safe || null
}

/**
 * Strictly validate and normalize a session ID for filesystem path usage.
 * Returns null when:
 * - input is missing/null-like
 * - sanitization changes the value (rejects traversal/special chars)
 *
 * This differs from sanitizeSessionId(), which is lenient and may strip chars.
 */
export function resolveSafeSessionId(sessionId: string | undefined | null): string | null {
  const safe = sanitizeSessionId(sessionId)
  if (!safe) return null
  if (sessionId !== safe) return null
  return safe
}
