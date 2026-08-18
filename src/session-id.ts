import { createHash } from "node:crypto"

/**
 * Canonical type alias for session identifiers used across commands and hooks.
 * Keep this as `string` for interoperability with on-disk IDs and hook payloads.
 */
export type SessionId = string

const HEX_UUID_LIKE_RE = /^[0-9a-fA-F]{4,8}(-[0-9a-fA-F]+)*$/i

/**
 * Legacy prefix derivation: takes first 4 hyphen-stripped characters.
 * Retained as a fallback so older tasks with 4-character path-head prefixes
 * (like "user-1" or "home-1") remain resolvable when unambiguous.
 */
export function legacySessionPrefix(sessionId: SessionId): string {
  return sessionId.replace(/-/g, "").slice(0, 4).toLowerCase()
}

/**
 * Derive a short stable prefix from a session ID for namespaced task IDs.
 * - For native UUID / hex session IDs: uses first 4 hex characters (e.g. "7ed7", "aaaa").
 * - For project keys and arbitrary path keys: hashes the full store key with SHA-256
 *   to produce a stable 4-hex prefix, ensuring distinct project paths never collide.
 */
export function sessionPrefix(sessionId: SessionId): string {
  if (!sessionId) return ""
  if (sessionId.length < 4) return sessionId.toLowerCase()
  if (!sessionId.startsWith("-") && HEX_UUID_LIKE_RE.test(sessionId)) {
    return sessionId.replace(/-/g, "").slice(0, 4).toLowerCase()
  }
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 4).toLowerCase()
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
