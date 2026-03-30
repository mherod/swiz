#!/usr/bin/env bun
// PreToolUse hook: once a hook response instructs the agent to record an
// update-memory DO/DON'T rule, block normal work until the transcript shows:
//   1. The update-memory skill was read
//   2. A markdown file write was performed
// Cooldown: if any CLAUDE.md (or MEMORY.md) in the project tree was modified
// within COOLDOWN_MS, skip enforcement — the agent is actively maintaining memory.

import { stat } from "node:fs/promises"
import { dirname, join } from "node:path"
import { getHomeDirOrNull } from "../src/home.ts"
import { projectKeyFromCwd } from "../src/project-key.ts"
import { readSessionTasks } from "../src/tasks/task-recovery.ts"
import {
  denyPreToolUse,
  extractToolBlocksFromEntry,
  formatActionPlan,
  hasFileInTree,
  isEditTool,
  isGitRepo,
  isNotebookTool,
  isWriteTool,
  readSessionLines,
} from "../src/utils/hook-utils.ts"
import { toolHookInputSchema } from "./schemas.ts"

const REMINDER_FRAGMENT =
  "record a DO or DON'T rule that proactively builds the required steps into your standard development workflow."
const SELF_SENTINEL = "MEMORY CAPTURE ENFORCEMENT"
const UPDATE_MEMORY_SKILL_PATH_FRAGMENT = "update-memory/SKILL.md"
const MARKDOWN_FILE_RE = /(?:^|[\\/])[^\\/\n]+\.md$/i
const APPLY_PATCH_MARKDOWN_RE = /^\*\*\* (?:Add|Update) File: .+\.md$/m
const COOLDOWN_MS = 30 * 60 * 1000 // 30 minutes

interface EnforcementState {
  skillReadComplete: boolean
  markdownWriteComplete: boolean
}

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out)
    return
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectStrings(item, out)
  }
}

function toolReadsUpdateMemorySkill(toolName: string, toolInput: unknown): boolean {
  if (!toolName) return false
  const strings: string[] = []
  collectStrings(toolInput, strings)
  return strings.some((value) => value.includes(UPDATE_MEMORY_SKILL_PATH_FRAGMENT))
}

function toolWritesMarkdown(toolName: string, toolInput: unknown): boolean {
  if (!isEditTool(toolName) && !isWriteTool(toolName) && !isNotebookTool(toolName)) {
    return false
  }

  const strings: string[] = []
  collectStrings(toolInput, strings)

  return strings.some(
    (value) => MARKDOWN_FILE_RE.test(value.trim()) || APPLY_PATCH_MARKDOWN_RE.test(value)
  )
}

/**
 * Returns true if any CLAUDE.md (or project MEMORY.md) file was modified
 * within COOLDOWN_MS. When true, the enforcement gate is skipped — the agent
 * is already actively maintaining memory.
 */
async function isMemoryRecentlyUpdated(cwd: string): Promise<boolean> {
  const candidates: string[] = []

  // Walk up from cwd collecting CLAUDE.md paths
  let dir = cwd
  while (true) {
    candidates.push(join(dir, "CLAUDE.md"))
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  // Also check the project auto-memory file
  const home = getHomeDirOrNull()
  if (home) {
    const encodedCwd = projectKeyFromCwd(cwd)
    candidates.push(join(home, ".claude", "projects", encodedCwd, "memory", "MEMORY.md"))
    candidates.push(join(home, ".claude", "MEMORY.md"))
  }

  const now = Date.now()
  for (const p of candidates) {
    try {
      const s = await stat(p)
      if (now - s.mtimeMs < COOLDOWN_MS) return true
    } catch {
      // File doesn't exist, or stat failed — skip
    }
  }
  return false
}

/**
 * Returns true if the current session has at least one task with status
 * "in_progress". When true, enforcement is deferred — the agent is actively
 * working on a task and should not be interrupted by memory-update detours.
 * Enforcement resumes naturally when no active task remains.
 */
async function hasActiveTask(sessionId: string | undefined): Promise<boolean> {
  if (!sessionId) return false
  const home = getHomeDirOrNull()
  if (!home) return false
  const tasks = await readSessionTasks(sessionId, home)
  return tasks.some((task) => task.status === "in_progress")
}

function updateStateFromToolUse(block: Record<string, unknown>, state: EnforcementState): void {
  const name = String(block.name)
  const input = block.input
  if (!state.skillReadComplete && toolReadsUpdateMemorySkill(name, input)) {
    state.skillReadComplete = true
  }
  if (!state.markdownWriteComplete && toolWritesMarkdown(name, input)) {
    state.markdownWriteComplete = true
  }
}

function processTranscriptEntry(line: string, state: EnforcementState): void {
  for (const block of extractToolBlocksFromEntry(line)) {
    updateStateFromToolUse(block, state)
    if (state.skillReadComplete && state.markdownWriteComplete) return
  }
}

function scanTranscript(lines: string[], startIndex: number): EnforcementState {
  const state: EnforcementState = {
    skillReadComplete: false,
    markdownWriteComplete: false,
  }

  for (let i = startIndex + 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line) continue
    try {
      processTranscriptEntry(line, state)
      if (state.skillReadComplete && state.markdownWriteComplete) return state
    } catch {
      // Ignore malformed transcript lines.
    }
  }

  return state
}

function findLastTriggerIndex(lines: string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line) continue
    if (line.includes(REMINDER_FRAGMENT) && !line.includes(SELF_SENTINEL)) return i
  }
  return -1
}

const POST_COMPACTION_MARKER = "Post-compaction context"

function wasCompactedAfterTrigger(lines: string[], triggerIndex: number): boolean {
  return lines.slice(triggerIndex + 1).some((l) => l.includes(POST_COMPACTION_MARKER))
}

function buildDenialReason(toolName: string, missingSkill: boolean): string {
  if (missingSkill) {
    return (
      `${SELF_SENTINEL}: ${toolName} is BLOCKED until you finish the required memory follow-through from an earlier hook response.\n\n` +
      formatActionPlan(
        [
          "Read the /update-memory skill by opening its SKILL.md.",
          "Write the resulting DO or DON'T rule into a project markdown file such as CLAUDE.md.",
        ],
        { header: "To resolve:" }
      ) +
      `\nThis gate clears automatically once the transcript shows both steps after the original reminder.`
    )
  }
  return (
    `${SELF_SENTINEL}: ${toolName} is BLOCKED until you record the required workflow rule in a markdown file.\n\n` +
    formatActionPlan(
      ["Write the DO or DON'T rule into a project markdown file such as CLAUDE.md."],
      { header: "To resolve:" }
    ) +
    `\nThis gate clears automatically once the transcript shows that markdown write after the original reminder.`
  )
}

async function shouldSkipEnforcement(
  cwd: string,
  transcriptPath: string,
  toolName: string
): Promise<boolean> {
  if (!transcriptPath || !toolName) return true
  if (!(await isGitRepo(cwd))) return true
  if (!(await hasFileInTree(cwd, "CLAUDE.md"))) return true
  return false
}

async function shouldSkipAfterTrigger(
  lines: string[],
  triggerIndex: number,
  cwd: string,
  sessionId: string | undefined
): Promise<boolean> {
  if (wasCompactedAfterTrigger(lines, triggerIndex)) return true
  if (await isMemoryRecentlyUpdated(cwd)) return true
  if (await hasActiveTask(sessionId)) return true
  return false
}

function isCurrentToolSatisfying(
  state: EnforcementState,
  toolName: string,
  toolInput: unknown
): boolean {
  if (state.skillReadComplete && state.markdownWriteComplete) return true
  if (!state.skillReadComplete && toolReadsUpdateMemorySkill(toolName, toolInput)) return true
  if (!state.markdownWriteComplete && toolWritesMarkdown(toolName, toolInput)) return true
  return false
}

async function main(): Promise<void> {
  const input = toolHookInputSchema.parse(await Bun.stdin.json())
  const transcriptPath = input.transcript_path ?? ""
  const toolName = input.tool_name ?? ""
  const toolInput = input.tool_input ?? {}
  const cwd = input.cwd ?? process.cwd()

  if (await shouldSkipEnforcement(cwd, transcriptPath, toolName)) return

  const lines = (await readSessionLines(transcriptPath)).filter((line) => line.trim())
  if (lines.length === 0) return

  const lastTriggerIndex = findLastTriggerIndex(lines)
  if (lastTriggerIndex < 0) return
  if (await shouldSkipAfterTrigger(lines, lastTriggerIndex, cwd, input.session_id)) return

  const state = scanTranscript(lines, lastTriggerIndex)
  if (isCurrentToolSatisfying(state, toolName, toolInput)) return

  denyPreToolUse(buildDenialReason(toolName, !state.skillReadComplete))
}

if (import.meta.main) await main()
