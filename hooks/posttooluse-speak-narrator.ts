#!/usr/bin/env bun
/**
 * Incremental TTS narrator — speaks only new assistant text since last call.
 * Shared by PostToolUse and Stop events.
 * Tracks spoken position per session in /tmp/speak-pos-<session>.txt.
 * Uses PID-aware file locking with heartbeats to prevent stale locks.
 */

import { getEffectiveSwizSettings, readSwizSettings } from "../src/settings.ts"
import { speakLockPath, speakPositionPath } from "../src/temp-paths.ts"
import { spawnSpeak } from "../src/utils/hook-utils.ts"

const input = await Bun.stdin.json().catch(() => null)
if (!input) process.exit(0)

const transcriptPath: string = ((input as Record<string, unknown>).transcript_path as string) ?? ""
const sessionId: string = ((input as Record<string, unknown>).session_id as string) ?? ""

// Check if speak is enabled using session-effective settings
const rawSettings = await readSwizSettings()
const settings = getEffectiveSwizSettings(rawSettings, sessionId || null)
if (!settings.speak) process.exit(0)

if (!transcriptPath || !sessionId || !(await Bun.file(transcriptPath).exists())) process.exit(0)

// ── Lock infrastructure (defined early so stale scavenging runs on every invocation) ──
const lockFile = speakLockPath(sessionId)
const LOCK_STALE_MS = 30_000
const HEARTBEAT_MS = 5_000

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function clearStaleLock(): Promise<void> {
  try {
    const content = (await Bun.file(lockFile).text()).trim()
    const ownerPid = parseInt(content, 10)
    const stats = await Bun.file(lockFile).stat()
    const age = Date.now() - stats.mtime.getTime()
    if (!Number.isNaN(ownerPid) && pidAlive(ownerPid) && age < LOCK_STALE_MS) return
    await Bun.file(lockFile).delete()
  } catch {
    // Lock doesn't exist or can't be read — nothing to clear
  }
}

// Scavenge stale locks on every invocation, even when exiting early
await clearStaleLock()

// Track last spoken line position
const posFile = speakPositionPath(sessionId)
let lastPos = 0
try {
  if (await Bun.file(posFile).exists()) {
    lastPos = parseInt((await Bun.file(posFile).text()).trim(), 10) || 0
  }
} catch {
  // Corrupted pos file — start from 0
}

// Read transcript lines
const lines = (await Bun.file(transcriptPath).text()).split("\n").filter(Boolean)
const totalLines = lines.length

if (totalLines <= lastPos) process.exit(0)

// Extract text from new assistant messages only
const newLines = lines.slice(lastPos)
const texts: string[] = []

for (const line of newLines) {
  try {
    const entry = JSON.parse(line)
    if (entry.type !== "assistant") continue
    for (const block of entry.message?.content ?? []) {
      if (block.type === "text" && block.text) {
        texts.push(block.text)
      }
    }
  } catch {
    // Skip malformed lines
  }
}

// Update position regardless of whether we speak
await Bun.write(posFile, String(totalLines))

const newText = texts.join(" ").replace(/\s+/g, " ").trim()

if (newText.length < 5) process.exit(0)

// Truncate to 500 chars
const truncated = newText.slice(0, 500)

async function acquireLock(timeoutMs = 10_000): Promise<boolean> {
  await clearStaleLock()
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (!(await Bun.file(lockFile).exists())) {
      try {
        await Bun.write(lockFile, String(process.pid))
        const owner = (await Bun.file(lockFile).text()).trim()
        if (owner === String(process.pid)) return true
      } catch {
        // Another process grabbed it — retry
      }
    }
    await clearStaleLock()
    await Bun.sleep(200)
  }
  return false
}

/** Touch the lock file mtime to signal the process is still active. */
async function heartbeat(): Promise<void> {
  try {
    await Bun.write(lockFile, String(process.pid))
  } catch {
    // Lock was removed — heartbeat no longer needed
  }
}

if (!(await acquireLock())) process.exit(0)

// Start heartbeat interval to keep lock alive during long say invocations
const heartbeatInterval = setInterval(() => {
  void heartbeat()
}, HEARTBEAT_MS)

// Speak, then release lock — delegate to shared spawnSpeak helper
try {
  await spawnSpeak(truncated, settings)
} finally {
  clearInterval(heartbeatInterval)
  try {
    await Bun.file(lockFile).delete()
  } catch {
    // Lock already cleared
  }
}
