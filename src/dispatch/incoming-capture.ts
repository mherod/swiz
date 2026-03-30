/**
 * Dispatch stdin payloads are written to `/tmp/swiz-incoming/` **by default** for inspection.
 *
 * **Disable** with **`SWIZ_CAPTURE_INCOMING=0`** or **`SWIZ_CAPTURE_INCOMING_PAYLOADS=0`** (also
 * `false`, `no`, `off`). Files older than **10 minutes** are removed on each write.
 *
 * Filename pattern: `{YYYY-MM-DD}T{HH-mm-ss-sss}-{hookEventName}-{id}.json` with `incoming` (before
 * `normalizeAgentHookPayload`) and `afterNormalizeAndBackfill`.
 *
 * **Secrets:** `_env` (injected by `swiz dispatch` for hook subprocesses) is **never** written —
 * it is replaced with `_envKeys` (sorted var names only). `user_email` is redacted.
 */

import { randomUUID } from "node:crypto"
import { mkdir, readdir, stat, unlink } from "node:fs/promises"
import { join } from "node:path"
import { debugLog } from "../debug.ts"
import { SWIZ_INCOMING_ROOT } from "../temp-paths.ts"

/** Age threshold for deleting prior capture files (10 minutes). */
export const SWIZ_INCOMING_RETENTION_MS = 10 * 60 * 1000

function isExplicitlyDisabled(v: string | undefined): boolean {
  if (v === undefined) return false
  if (v === "") return true
  return ["0", "false", "no", "off"].includes(v.toLowerCase())
}

/** Capture is on unless either env var explicitly disables it. */
export function shouldCaptureIncomingPayloads(): boolean {
  if (isExplicitlyDisabled(process.env.SWIZ_CAPTURE_INCOMING)) return false
  if (isExplicitlyDisabled(process.env.SWIZ_CAPTURE_INCOMING_PAYLOADS)) return false
  return true
}

/** Safe single path segment for filenames. */
export function sanitizeHookFilenameSegment(name: string): string {
  const s = name.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "hook"
  return s.slice(0, 120)
}

/**
 * Strip high-risk fields from dispatch payloads before writing to disk. The CLI injects full
 * `process.env` as `_env` — that must not be persisted in `/tmp`.
 */
export function sanitizeDispatchPayloadForCapture(
  o: Record<string, unknown>
): Record<string, unknown> {
  const out = structuredClone(o) as Record<string, unknown>
  if (out._env && typeof out._env === "object" && !Array.isArray(out._env)) {
    out._envKeys = Object.keys(out._env as Record<string, unknown>).sort()
    delete out._env
  }
  if (typeof out.user_email === "string" && out.user_email.includes("@")) {
    out.user_email = "[redacted]"
  }
  return out
}

export function buildIncomingCaptureFilename(hookEventName: string): string {
  const iso = new Date().toISOString()
  const datePart = iso.slice(0, 10)
  const timePart = iso.slice(11, 23).replace(/:/g, "-")
  const safe = sanitizeHookFilenameSegment(hookEventName)
  const id = randomUUID().slice(0, 8)
  return `${datePart}T${timePart}-${safe}-${id}.json`
}

/** Remove `*.json` under `dir` whose mtime is older than `maxAgeMs`. */
export async function pruneStaleIncomingCaptures(
  dir: string = SWIZ_INCOMING_ROOT,
  maxAgeMs: number = SWIZ_INCOMING_RETENTION_MS
): Promise<void> {
  const now = Date.now()
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const ent of entries) {
      if (!ent.isFile()) continue
      if (!ent.name.endsWith(".json")) continue
      const full = join(dir, ent.name)
      try {
        const s = await stat(full)
        if (now - s.mtimeMs > maxAgeMs) await unlink(full)
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code
        if (code === "ENOENT") continue
        debugLog(
          "[incoming-capture] prune entry failed:",
          full,
          e instanceof Error ? e.message : String(e)
        )
      }
    }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === "ENOENT") return
    debugLog("[incoming-capture] prune readdir failed:", e instanceof Error ? e.message : String(e))
  }
}

export interface IncomingDispatchCaptureArgs {
  canonicalEvent: string
  hookEventName: string
  parseError: boolean
  payloadStr: string
  /** Clone of payload before `normalizeAgentHookPayload`; null when `parseError`. */
  incomingBeforeNormalize: Record<string, unknown> | null
  /** Clone of payload after normalize + backfill. */
  normalizedPayload: Record<string, unknown>
}

/** Caller should invoke only when `shouldCaptureIncomingPayloads()` is true. */
export function scheduleIncomingDispatchCapture(args: IncomingDispatchCaptureArgs): void {
  void writeIncomingDispatchCapture(args).catch((err) => {
    debugLog("[incoming-capture] failed:", err instanceof Error ? err.message : String(err))
  })
}

async function writeIncomingDispatchCapture(args: IncomingDispatchCaptureArgs): Promise<void> {
  await mkdir(SWIZ_INCOMING_ROOT, { recursive: true })
  await pruneStaleIncomingCaptures()
  const filename = buildIncomingCaptureFilename(args.hookEventName)
  const path = join(SWIZ_INCOMING_ROOT, filename)

  const envelope: Record<string, unknown> = {
    _swizIncomingCapture: {
      canonicalEvent: args.canonicalEvent,
      hookEventName: args.hookEventName,
      capturedAt: new Date().toISOString(),
      parseError: args.parseError,
    },
  }

  if (args.parseError) {
    envelope.rawPayload = args.payloadStr
  } else {
    if (args.incomingBeforeNormalize) {
      envelope.incoming = sanitizeDispatchPayloadForCapture(args.incomingBeforeNormalize)
    }
    envelope.afterNormalizeAndBackfill = sanitizeDispatchPayloadForCapture(args.normalizedPayload)
  }

  await Bun.write(path, `${JSON.stringify(envelope, null, 2)}\n`)
}
