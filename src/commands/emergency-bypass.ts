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
}

function getRepoKey(): string {
  return getCanonicalPathHash(process.cwd())
}

function getSentinelPath(): string {
  return swizEmergencyBypassPath(getRepoKey())
}

async function readBypassState(): Promise<BypassState | null> {
  try {
    const raw = await readFile(getSentinelPath(), "utf8")
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

export const emergencyBypassCommand: Command = {
  name: "emergency-bypass",
  description: "Activate a time-limited PreToolUse hook bypass for deadlock recovery",
  usage: "swiz emergency-bypass [--duration <seconds>] [--status]",
  options: [
    { flags: "--duration <seconds>", description: "Override duration (max 300s, default 120s)" },
    { flags: "--status", description: "Show current bypass state" },
  ],

  async run(args: string[]) {
    if (args.includes("--status")) {
      const state = await readBypassState()
      if (!state || Date.now() >= state.expiresAt) {
        console.error("Emergency bypass: inactive")
        return
      }
      const remainingMs = state.expiresAt - Date.now()
      const remainingSec = Math.ceil(remainingMs / 1000)
      console.error(`Emergency bypass: ACTIVE (${remainingSec}s remaining)`)
      console.error(`  Activated: ${new Date(state.activatedAt).toISOString()}`)
      console.error(`  Expires:   ${new Date(state.expiresAt).toISOString()}`)
      return
    }

    // Parse duration
    let durationS = DEFAULT_DURATION_S
    const durationIdx = args.indexOf("--duration")
    if (durationIdx !== -1) {
      const rawDuration = args[durationIdx + 1] ?? ""
      const parsed = parseInt(rawDuration, 10)
      if (Number.isNaN(parsed) || parsed <= 0) {
        throw new Error("Duration must be a positive integer (seconds)")
      }
      durationS = parsed
    }

    const durationMs = Math.min(durationS * 1000, MAX_DURATION_MS)
    if (durationS * 1000 > MAX_DURATION_MS) {
      console.error(`Duration clamped to ${MAX_DURATION_MS / 1000}s (requested ${durationS}s)`)
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
      repoKey: getRepoKey(),
    }

    await writeFile(getSentinelPath(), JSON.stringify(state, null, 2))

    const expirySec = Math.round(durationMs / 1000)
    console.error(`Emergency bypass ACTIVATED for ${expirySec}s`)
    console.error(
      `  All preToolUse hook denials will be skipped until ${new Date(state.expiresAt).toISOString()}`
    )
    console.error(`  Stop and postToolUse hooks remain active.`)
    console.error(`  Next activation available in 60 minutes.`)
  },
}
