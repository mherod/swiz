#!/usr/bin/env bun
/**
 * PostToolUse hook: Deliver native macOS notifications for task lifecycle events.
 *
 * Fires on TaskCreate (new task) and TaskUpdate (status changed).
 * For TaskCreate: reads subject from tool_input.subject.
 * For TaskUpdate: looks up subject from the task JSON file.
 *
 * async: true — fire-and-forget, never blocks the agent loop.
 */

import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { getSessionTaskPath, resolveSafeSessionId } from "./hook-utils.ts"
import { toolHookInputSchema } from "./schemas.ts"

const raw = await Bun.stdin.json().catch(() => null)
if (!raw) process.exit(0)

const parsed = toolHookInputSchema.safeParse(raw)
if (!parsed.success) process.exit(0)

const input = parsed.data
const toolName = input.tool_name ?? ""
if (toolName !== "TaskCreate" && toolName !== "TaskUpdate") process.exit(0)
const sessionId = resolveSafeSessionId(input.session_id)
if (!sessionId || !input.tool_input) process.exit(0)

// ── Resolve binary ─────────────────────────────────────────────────────────
function resolveBinary(): string | null {
  const envOverride = process.env.SWIZ_NOTIFY_BIN
  if (envOverride && existsSync(envOverride)) return envOverride

  const repoRoot = join(import.meta.dir, "..")
  const devPath = join(repoRoot, "macos", "SwizNotify.app", "Contents", "MacOS", "swiz-notify")
  if (existsSync(devPath)) return devPath

  const installed = "/usr/local/bin/swiz-notify"
  if (existsSync(installed)) return installed

  return null
}

const binary = resolveBinary()
if (!binary) process.exit(0)

// ── Extract fields ─────────────────────────────────────────────────────────
const ti = input.tool_input
const status = String(ti.status ?? "")

// ── Resolve subject ────────────────────────────────────────────────────────
let subject = String(ti.subject ?? "")

if (!subject && toolName === "TaskUpdate") {
  const taskId = String(ti.taskId ?? ti.task_id ?? ti.id ?? "")
  if (taskId) {
    const taskPath = getSessionTaskPath(sessionId, taskId, homedir())
    if (taskPath) {
      try {
        const taskJson = JSON.parse(await Bun.file(taskPath).text())
        subject = String(taskJson.subject ?? "")
      } catch {
        // Task file not found or unreadable — skip silently
      }
    }
  }
}

if (!subject) process.exit(0)

// ── Build notification body ────────────────────────────────────────────────
function buildBody(): string | null {
  if (toolName === "TaskCreate") return `＋ ${subject}`
  switch (status) {
    case "in_progress":
      return `▶ ${subject}`
    case "completed":
      return `✓ ${subject}`
    case "cancelled":
      return `✗ ${subject}`
    default:
      return null
  }
}

const body = buildBody()
if (!body) process.exit(0)

// ── Deliver notification ───────────────────────────────────────────────────
const proc = Bun.spawn(
  [binary, "--title", "swiz tasks", "--body", body, "--sound", "Bottle", "--timeout", "3"],
  { stdout: "inherit", stderr: "inherit" }
)

await proc.exited
process.exit(0)
