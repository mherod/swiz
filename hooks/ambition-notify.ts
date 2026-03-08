#!/usr/bin/env bun
/**
 * Background helper: show an ambitionMode status notification via swiz-notify
 * and update the global ambition-mode setting when the user taps a button.
 *
 * Called as a detached process from stop-auto-continue.ts:
 *   bun hooks/ambition-notify.ts <binary> <currentMode> <nextStep> [cwd]
 *
 * The process outlives the stop hook and exits after the user taps a button
 * (or after the timeout elapses).
 */

import { join } from "node:path"

const [binary, currentMode = "standard", rawNext = "", cwd = process.cwd()] = process.argv.slice(2)

if (!binary) process.exit(0)

// ── Notification content ──────────────────────────────────────────────────────
const MODES = ["standard", "aggressive", "creative", "reflective"] as const
type Mode = (typeof MODES)[number]

const MODE_LABELS: Record<Mode, string> = {
  standard: "Standard",
  aggressive: "Aggressive",
  creative: "Creative",
  reflective: "Reflective",
}

const truncated = rawNext.length > 100 ? `${rawNext.slice(0, 97)}…` : rawNext
const body = truncated || `Currently in ${currentMode} mode`

// ── Build swiz-notify args ────────────────────────────────────────────────────
const args: string[] = [
  binary,
  "--title",
  `swiz · mode: ${currentMode}`,
  "--body",
  body,
  "--sound",
  "Bottle",
  "--timeout",
  "60",
]

// Offer all modes except the current one as buttons
for (const mode of MODES) {
  if (mode === currentMode) continue
  args.push("--action", mode, `→ ${MODE_LABELS[mode]}`)
}

// ── Spawn and wait for user response ─────────────────────────────────────────
const proc = Bun.spawn(args, { stdout: "pipe", stderr: "ignore" })
const [stdout] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
const chosen = stdout.trim() as Mode | ""

if (!chosen || !MODES.includes(chosen as Mode)) process.exit(0)

// ── Apply the chosen mode via swiz CLI ───────────────────────────────────────
const swizIndex = join(import.meta.dir, "..", "index.ts")
const applyProc = Bun.spawn(
  ["bun", swizIndex, "settings", "set", "ambition-mode", chosen, "--global"],
  { cwd, stdout: "inherit", stderr: "inherit" }
)
await applyProc.exited
process.exit(0)
