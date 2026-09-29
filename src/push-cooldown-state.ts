/**
 * The shared push-cooldown sentinel record (#847).
 *
 * The cooldown guards a repo-wide resource (the CI runner), so it stays keyed by repository.
 * The record also names the session that armed it, so a peer session blocked by it is not told
 * that it pushed. One parser serves the pre-tool hook and `swiz push-wait`, and it still accepts
 * the legacy bare-timestamp sentinel.
 */

import { z } from "zod"
import type { JsonLike } from "./schemas.ts"

export interface PushCooldownRecord {
  /** Epoch milliseconds of the push that armed the cooldown. */
  at: number
  /** Session that armed it; absent for legacy records or payloads without a session. */
  sessionId?: string
}

const SAFE_SESSION_ID_RE = /^[A-Za-z0-9._:-]{1,80}$/

/** The stored JSON shape; the session id is re-checked by `safeSessionId` before use. */
const storedRecordSchema = z.object({ at: z.number().finite(), sessionId: z.string().optional() })

/** Keep only a bounded, printable session id; anything else becomes unknown provenance. */
function safeSessionId(value: string | null | undefined): string | undefined {
  return value && SAFE_SESSION_ID_RE.test(value) ? value : undefined
}

export function serializePushCooldownRecord(at: number, sessionId?: string | null): string {
  const safe = safeSessionId(sessionId)
  return JSON.stringify(safe ? { at, sessionId: safe } : { at })
}

/** Parse a sentinel's text, or null when it is missing, empty or corrupt. */
export function parsePushCooldownRecord(raw: string): PushCooldownRecord | null {
  const text = raw.trim()
  if (text === "") return null
  if (/^\d+$/.test(text)) return { at: Number(text) }
  let json: JsonLike
  try {
    json = JSON.parse(text) as JsonLike
  } catch {
    return null
  }
  const parsed = storedRecordSchema.safeParse(json)
  if (!parsed.success) return null
  const sessionId = safeSessionId(parsed.data.sessionId)
  return sessionId ? { at: parsed.data.at, sessionId } : { at: parsed.data.at }
}

/** Read and parse the sentinel at `path`, treating any read failure as no cooldown. */
export async function readPushCooldownRecord(path: string): Promise<PushCooldownRecord | null> {
  try {
    const file = Bun.file(path)
    if (!(await file.exists())) return null
    return parsePushCooldownRecord(await file.text())
  } catch {
    return null
  }
}

/** Who armed the cooldown, phrased relative to the session now being blocked. */
export function describePushCooldownArmer(
  record: PushCooldownRecord,
  currentSessionId?: string | null
): string {
  if (!record.sessionId) return "by an unknown session"
  if (record.sessionId === currentSessionId) return "by this session"
  return `by another session (\`${record.sessionId}\`)`
}
