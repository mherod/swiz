/**
 * Emergency bypass for PreToolUse hooks.
 *
 * Activates a short-lived window (max 5 minutes) during which all preToolUse
 * hook denials are skipped. Stop and postToolUse hooks continue normally.
 *
 * Rate-limited: at most once per rolling hour per repo.
 *
 * Usage:
 *   swiz emergency-bypass [--duration <seconds>] [--status]
 */

import { readFile, writeFile } from "node:fs/promises"
import { stderrLog } from "../debug.ts"
import { getCanonicalPathHash } from "../git-helpers.ts"
import { swizEmergencyBypassPath } from "../temp-paths.ts"
import type { Command } from "../types.ts"

const MAX_DURATION_MS = 5 * 60 * 1000 // 5 minutes
const COOLDOWN_MS = 60 * 60 * 1000 // 1 hour
const DEFAULT_DURATION_S = 120 // 2 minutes

interface BypassState {
  activatedAt: number
  expiresAt: number
  repoKey: string
  /**
   * Session the bypass is bound to. Set by --session at activation, or claimed
   * by the first attributable preToolUse dispatch afterwards (issue #840).
   */
  sessionId?: string
}

async function readBypassState(): Promise<BypassState | null> {
  try {
    const raw = await readFile(swizEmergencyBypassPath(getCanonicalPathHash(process.cwd())), "utf8")
    return JSON.parse(raw) as BypassState
  } catch {
    return null
  }
}

export async function isEmergencyBypassActive(repoKey: string): Promise<boolean> {
  try {
    const raw = await readFile(swizEmergencyBypassPath(repoKey), "utf8")
    const state = JSON.parse(raw) as BypassState
    return Date.now() < state.expiresAt
  } catch {
    return false
  }
}

/**
 * Whether the bypass applies to this dispatch, binding the bypass to exactly
 * one session (issue #840). The repo-keyed sentinel alone disarmed every
 * preToolUse guard for every session sharing the checkout; the bypass now
 * belongs to a single session — the one named by --session at activation, or,
 * because the activating session cannot always know its own id, the first
 * attributable dispatch to arrive afterwards claims it. Unattributable
 * dispatches (no session_id in the payload) never bypass. A concurrent claim
 * is last-write-wins; the loser falls back to guarded dispatches, which is
 * the safe side.
 */
export async function resolveEmergencyBypassForSession(
  repoKey: string,
  sessionId: string | null
): Promise<boolean> {
  if (!sessionId) return false
  let state: BypassState
  try {
    const raw = await readFile(swizEmergencyBypassPath(repoKey), "utf8")
    state = JSON.parse(raw) as BypassState
  } catch {
    return false
  }
  if (Date.now() >= state.expiresAt) return false
  if (state.sessionId) return state.sessionId === sessionId
  try {
    await writeFile(
      swizEmergencyBypassPath(repoKey),
      JSON.stringify({ ...state, sessionId }, null, 2)
    )
  } catch {
    // Claim write failed — honour the bypass for this dispatch; the next
    // attributable dispatch retries the claim.
  }
  return true
}

async function showBypassStatus(): Promise<void> {
  const state = await readBypassState()
  if (!state || Date.now() >= state.expiresAt) {
    stderrLog("emergency-bypass status", "Emergency bypass: inactive")
    return
  }
  const remainingSec = Math.ceil((state.expiresAt - Date.now()) / 1000)
  stderrLog("emergency-bypass status", `Emergency bypass: ACTIVE (${remainingSec}s remaining)`)
  stderrLog("emergency-bypass status", `  Activated: ${new Date(state.activatedAt).toISOString()}`)
  stderrLog("emergency-bypass status", `  Expires:   ${new Date(state.expiresAt).toISOString()}`)
}

function parseDurationArg(args: string[]): number {
  const durationIdx = args.indexOf("--duration")
  if (durationIdx === -1) return DEFAULT_DURATION_S
  const parsed = parseInt(args[durationIdx + 1] ?? "", 10)
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new Error("Duration must be a positive integer (seconds)")
  }
  return parsed
}

function parseSessionArg(args: string[]): string | undefined {
  const sessionIdx = args.indexOf("--session")
  if (sessionIdx === -1) return undefined
  const rawSession = (args[sessionIdx + 1] ?? "").trim()
  if (!rawSession) throw new Error("--session requires a session id")
  return rawSession
}

export const emergencyBypassCommand: Command = {
  name: "emergency-bypass",
  description: "Activate a time-limited PreToolUse hook bypass for deadlock recovery",
  usage: "swiz emergency-bypass [--duration <seconds>] [--status]",
  options: [
    { flags: "--duration <seconds>", description: "Override duration (max 300s, default 120s)" },
    {
      flags: "--session <id>",
      description:
        "Bind the bypass to one agent session id (default: the first dispatch after activation claims it)",
    },
    { flags: "--status", description: "Show current bypass state" },
  ],

  async run(args: string[]) {
    if (args.includes("--status")) return showBypassStatus()

    const durationS = parseDurationArg(args)
    const sessionId = parseSessionArg(args)

    const durationMs = Math.min(durationS * 1000, MAX_DURATION_MS)
    if (durationS * 1000 > MAX_DURATION_MS) {
      stderrLog(
        "emergency-bypass clamp",
        `Duration clamped to ${MAX_DURATION_MS / 1000}s (requested ${durationS}s)`
      )
    }

    // Check cooldown — can only activate once per hour
    const existing = await readBypassState()
    if (existing) {
      const sinceActivation = Date.now() - existing.activatedAt
      if (sinceActivation < COOLDOWN_MS) {
        const waitSec = Math.ceil((COOLDOWN_MS - sinceActivation) / 1000)
        throw new Error(
          `Rate limited: emergency bypass was activated ${Math.floor(sinceActivation / 1000)}s ago. ` +
            `Next activation available in ${waitSec}s.`
        )
      }
    }

    const now = Date.now()
    const state: BypassState = {
      activatedAt: now,
      expiresAt: now + durationMs,
      repoKey: getCanonicalPathHash(process.cwd()),
      ...(sessionId ? { sessionId } : {}),
    }

    await writeFile(
      swizEmergencyBypassPath(getCanonicalPathHash(process.cwd())),
      JSON.stringify(state, null, 2)
    )

    const expirySec = Math.round(durationMs / 1000)
    stderrLog("emergency-bypass activate", `Emergency bypass ACTIVATED for ${expirySec}s`)
    stderrLog(
      "emergency-bypass activate",
      `  preToolUse hook denials will be skipped until ${new Date(state.expiresAt).toISOString()}`
    )
    stderrLog(
      "emergency-bypass activate",
      sessionId
        ? `  Scope: session ${sessionId} only.`
        : `  Scope: the first agent session to dispatch after activation claims the bypass; other sessions stay guarded.`
    )
    stderrLog("emergency-bypass activate", `  Stop and postToolUse hooks remain active.`)
    stderrLog("emergency-bypass activate", `  Next activation available in 60 minutes.`)
  },
}
