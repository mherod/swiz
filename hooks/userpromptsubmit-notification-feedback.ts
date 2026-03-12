#!/usr/bin/env bun

// UserPromptSubmit hook: Inject pending swiz-notify action results into context.
// Reads ~/.swiz/notification-feedback.jsonl, filters entries matching the current
// cwd (targetCwd), emits them as context, then removes consumed entries from the file.

import { existsSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { emitContext } from "./hook-utils.ts"
import { sessionHookInputSchema } from "./schemas.ts"

interface NotificationFeedback {
  ts: number
  type?: string
  actionId: string
  userText?: string
  prNumber?: number
  taskId?: string
  targetCwd: string
}

const FEEDBACK_FILE = join(process.env.HOME ?? "~", ".swiz", "notification-feedback.jsonl")

async function main(): Promise<void> {
  const raw = await Bun.stdin.text()
  const input = sessionHookInputSchema.parse(JSON.parse(raw))
  const cwd = input.cwd

  if (!existsSync(FEEDBACK_FILE)) return

  const fileContent = await readFile(FEEDBACK_FILE, "utf8")
  const lines = fileContent.split("\n").filter((l) => l.trim().length > 0)
  if (lines.length === 0) return

  const all: NotificationFeedback[] = []
  for (const line of lines) {
    try {
      all.push(JSON.parse(line) as NotificationFeedback)
    } catch {
      // skip malformed lines
    }
  }

  const matching = all.filter((e) => e.targetCwd === cwd)
  if (matching.length === 0) return

  const remaining = all.filter((e) => e.targetCwd !== cwd)

  // Write back only non-matching entries
  await writeFile(
    FEEDBACK_FILE,
    remaining.map((e) => JSON.stringify(e)).join("\n") + (remaining.length > 0 ? "\n" : ""),
    "utf8"
  )

  // Build context message
  const contextLines: string[] = [
    `[notification-feedback] ${matching.length} pending notification result(s):`,
  ]
  for (const entry of matching) {
    const ts = new Date(entry.ts).toISOString()
    if (entry.userText !== undefined) {
      contextLines.push(`  [${ts}] action=${entry.actionId} reply="${entry.userText}"`)
    } else {
      contextLines.push(`  [${ts}] action=${entry.actionId} tapped`)
    }
    if (entry.prNumber !== undefined) contextLines.push(`    PR: #${entry.prNumber}`)
    if (entry.taskId !== undefined) contextLines.push(`    Task: ${entry.taskId}`)
  }

  emitContext("UserPromptSubmit", contextLines.join("\n"), cwd)
}

if (import.meta.main) void main()
