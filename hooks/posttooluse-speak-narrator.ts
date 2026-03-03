#!/usr/bin/env bun
/**
 * Incremental TTS narrator — speaks only new assistant text since last call.
 * Shared by PostToolUse and Stop events.
 * Tracks spoken position per session in /tmp/speak-pos-<session>.txt.
 * Uses PID-aware file locking with heartbeats to prevent stale locks.
 */

import { existsSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { readSwizSettings } from "../src/settings.ts"

// Check if speak is enabled in swiz settings (disabled by default)
const settings = await readSwizSettings()
if (!settings.speak) process.exit(0)

const input = await Bun.stdin.json().catch(() => null)
if (!input) process.exit(0)

const transcriptPath: string = ((input as Record<string, unknown>).transcript_path as string) ?? ""
const sessionId: string = ((input as Record<string, unknown>).session_id as string) ?? ""

if (!transcriptPath || !sessionId || !existsSync(transcriptPath)) process.exit(0)

// ── Lock infrastructure (defined early so stale scavenging runs on every invocation) ──
const lockFile = `/tmp/speak-lock-${sessionId}.lock`
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

function clearStaleLock(): void {
  try {
    const content = readFileSync(lockFile, "utf-8").trim()
    const ownerPid = parseInt(content, 10)
    const stat = statSync(lockFile)
    const age = Date.now() - stat.mtimeMs
    if (!isNaN(ownerPid) && pidAlive(ownerPid) && age < LOCK_STALE_MS) return
    unlinkSync(lockFile)
  } catch {
    // Lock doesn't exist or can't be read — nothing to clear
  }
}

// Scavenge stale locks on every invocation, even when exiting early
clearStaleLock()

// Track last spoken line position
const posFile = `/tmp/speak-pos-${sessionId}.txt`
let lastPos = 0
if (existsSync(posFile)) {
  try {
    lastPos = parseInt(readFileSync(posFile, "utf-8").trim(), 10) || 0
  } catch {
    // Corrupted pos file — start from 0
  }
}

// Read transcript lines
const lines = readFileSync(transcriptPath, "utf-8").split("\n").filter(Boolean)
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
writeFileSync(posFile, String(totalLines))

const newText = texts.join(" ").replace(/\s+/g, " ").trim()

if (newText.length < 5) process.exit(0)

// Truncate to 500 chars
const truncated = newText.slice(0, 500)

async function acquireLock(timeoutMs = 10_000): Promise<boolean> {
  clearStaleLock()
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (!existsSync(lockFile)) {
      try {
        writeFileSync(lockFile, String(process.pid), { flag: "wx" })
        return true
      } catch {
        // Another process grabbed it — retry
      }
    }
    clearStaleLock()
    await Bun.sleep(200)
  }
  return false
}

/** Touch the lock file mtime to signal the process is still active. */
function heartbeat(): void {
  try {
    const now = new Date()
    utimesSync(lockFile, now, now)
  } catch {
    // Lock was removed — heartbeat no longer needed
  }
}

if (!(await acquireLock())) process.exit(0)

// Start heartbeat interval to keep lock alive during long say invocations
const heartbeatInterval = setInterval(heartbeat, HEARTBEAT_MS)

// Speak, then release lock — invoke sibling speak.ts from the hooks directory
const speakScript = join(dirname(import.meta.path), "speak.ts")

try {
  const proc = Bun.spawn(["bun", speakScript], {
    stdin: new Response(truncated).body!,
    stderr: "pipe",
  })

  const stderr = await new Response(proc.stderr).text()
  await proc.exited

  if (proc.exitCode !== 0 && stderr) {
    writeFileSync(`/tmp/speak-error-${sessionId}.log`, stderr)
  }
} finally {
  clearInterval(heartbeatInterval)
  try {
    unlinkSync(lockFile)
  } catch {
    // Lock already cleared
  }
}
