#!/usr/bin/env bun

/**
 * Notification hook: deliver Claude Code notification events as rich
 * native macOS system notifications via the swiz-notify binary.
 *
 * Payload fields used:
 *   message          — notification body (always present)
 *   title            — override title (optional, falls back to type-based default)
 *   notification_type — "permission_prompt" | "idle_prompt" | ...
 */

import { existsSync } from "node:fs"
import { join } from "node:path"
import { sessionHookInputSchema } from "./schemas.ts"

const raw = await Bun.stdin.json().catch(() => null)
if (!raw) process.exit(0)

const parsed = sessionHookInputSchema.safeParse(raw)
const input = parsed.success ? parsed.data : (raw as Record<string, unknown>)

const message = (input.message as string | undefined)?.trim() ?? ""
const notificationType = (input.notification_type as string | undefined) ?? ""
const providedTitle = (input.title as string | undefined)?.trim() ?? ""

if (!message) process.exit(0)

// ── Resolve binary ────────────────────────────────────────────────────────────
function resolveBinary(): string | null {
  const envOverride = process.env.SWIZ_NOTIFY_BIN
  if (envOverride !== undefined) {
    // When set explicitly (e.g. in tests), treat as authoritative — no fallthrough
    return existsSync(envOverride) ? envOverride : null
  }

  const repoRoot = join(import.meta.dir, "..")
  const devPath = join(repoRoot, "macos", "SwizNotify.app", "Contents", "MacOS", "swiz-notify")
  if (existsSync(devPath)) return devPath

  const installed = "/usr/local/bin/swiz-notify"
  if (existsSync(installed)) return installed

  return null
}

const binary = resolveBinary()
if (!binary) process.exit(0)

// ── Title and sound per notification type ─────────────────────────────────────
function titleForType(type: string): string {
  if (providedTitle) return providedTitle
  switch (type) {
    case "permission_prompt":
      return "⚠️ Claude needs permission"
    case "idle_prompt":
      return "💬 Claude is waiting"
    default:
      return "Claude Code"
  }
}

function soundForType(type: string): string {
  switch (type) {
    case "permission_prompt":
      return "Glass"
    case "idle_prompt":
      return "Ping"
    default:
      return "default"
  }
}

const proc = Bun.spawn(
  [
    binary,
    "--title",
    titleForType(notificationType),
    "--body",
    message,
    "--sound",
    soundForType(notificationType),
    "--timeout",
    "3",
  ],
  { stdout: "inherit", stderr: "inherit" }
)

await proc.exited
process.exit(0)
