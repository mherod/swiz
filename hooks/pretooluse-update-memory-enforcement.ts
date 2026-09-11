#!/usr/bin/env bun
// PreToolUse hook: once a hook response instructs the agent to record an
// update-memory DO/DON'T rule, block normal work until the transcript shows:
//   1. The update-memory skill was read
//   2. A repository memory write was performed
// Cooldown: if repository memory was modified
// within COOLDOWN_MS, skip enforcement — the agent is actively maintaining memory.

import { stat } from "node:fs/promises"
import { resolve } from "node:path"
import { formatActionPlan } from "../src/action-plan.ts"
import { GATE_REQUIRED_SKILLS } from "../src/gate-required-skills.ts"
import { getHomeDirOrNull } from "../src/home.ts"
import {
  isProjectMemoryPath,
  PROJECT_MEMORY_GUIDANCE,
  type ProjectMemoryLocation,
  projectMemorySources,
  resolveProjectMemory,
} from "../src/project-memory.ts"
import { isGitRepoForHookPayload } from "../src/repository-capability.ts"
import type { SwizHookOutput, SwizToolHook } from "../src/SwizHook.ts"
import { preToolUseDeny, runSwizHookAsMain } from "../src/SwizHook.ts"
import { type ToolHookInput, toolHookInputSchema } from "../src/schemas.ts"
import {
  resolveSkillFilePathForHookPayload,
  resolveSkillRecencyOptions,
} from "../src/skill-utils.ts"
import { readSessionTasks } from "../src/tasks/task-recovery.ts"
import {
  extractFileEditTargetPaths,
  isEditTool,
  isNotebookTool,
  isShellTool,
  isWriteTool,
} from "../src/tool-matchers.ts"
import { getSuccessfulToolCalls, toolLoadsSkill } from "../src/transcript-summary.ts"
import {
  extractTextFromUnknownContent,
  isHookFeedback,
  stripQuotedText,
} from "../src/transcript-utils.ts"
import { resolveSessionLines } from "../src/utils/transcript.ts"

const REMINDER_FRAGMENT =
  "record a DO or DON'T rule that proactively builds the required steps into your standard development workflow."
const SELF_SENTINEL = "MEMORY CAPTURE ENFORCEMENT"
const UPDATE_MEMORY_SKILL = GATE_REQUIRED_SKILLS.updateMemory.name
const COOLDOWN_MS = 30 * 60 * 1000 // 30 minutes
// Matches individual auto-memory entries under ~/.claude/projects/<key>/memory/<slug>.md.
// These are written by the built-in auto-memory system, not the /update-memory skill,
// so enforcement must neither block nor treat them as satisfying the enforcement requirement.
const AUTO_MEMORY_PATH_RE = /[/\\]\.claude[/\\]projects[/\\][^/\\]+[/\\]memory[/\\][^/\\]+\.md$/i
const CODEX_MEMORY_PATH_RE = /[/\\]\.codex[/\\]memories[/\\].+\.md$/i

interface EnforcementState {
  skillReadComplete: boolean
  markdownWriteComplete: boolean
}

interface ToolSatisfactionContext {
  skillPath: string | null
  cwd: string
  location: ProjectMemoryLocation
}

function editPaths(value: unknown): string[] {
  if (typeof value === "string") return extractFileEditTargetPaths({ command: value })
  return value && typeof value === "object" ? extractFileEditTargetPaths(value) : []
}

function isAutoMemoryPath(path: string): boolean {
  return AUTO_MEMORY_PATH_RE.test(path.trim()) || CODEX_MEMORY_PATH_RE.test(path.trim())
}

function toolWritesMarkdown(
  toolName: string,
  toolInput: unknown,
  cwd: string,
  location: ProjectMemoryLocation
): boolean {
  if (!isEditTool(toolName) && !isWriteTool(toolName) && !isNotebookTool(toolName)) {
    return false
  }

  return editPaths(toolInput).some((path) => isProjectMemoryPath(resolve(cwd, path), location))
}

/**
 * Returns true if any CLAUDE.md (or project MEMORY.md) file was modified
 * within COOLDOWN_MS. When true, the enforcement gate is skipped — the agent
 * is already actively maintaining memory.
 */
async function isMemoryRecentlyUpdated(cwd: string): Promise<boolean> {
  const location = await resolveProjectMemory(cwd)
  if (!location) return false
  const candidates = (await projectMemorySources(location)).map((source) => source.path)
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
 */
async function hasActiveTask(sessionId: string | undefined): Promise<boolean> {
  if (!sessionId) return false
  const home = getHomeDirOrNull()
  if (!home) return false
  const tasks = await readSessionTasks(sessionId, home)
  return tasks.some((task) => task.status === "in_progress")
}

function isReminderTriggerEntry(line: string): boolean {
  let entry: Record<string, any>
  try {
    entry = JSON.parse(line) as Record<string, any>
  } catch {
    return false
  }

  if (entry?.type !== "user") return false

  const content = (entry as { message?: { content?: unknown } })?.message?.content
  if ((typeof content !== "string" && !Array.isArray(content)) || !isHookFeedback(content)) {
    return false
  }

  const text = stripQuotedText(extractTextFromUnknownContent(content))
  return text.includes(REMINDER_FRAGMENT) && !text.includes(SELF_SENTINEL)
}

function findLastTriggerIndex(lines: string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line) continue
    if (isReminderTriggerEntry(line)) return i
  }
  return -1
}

const POST_COMPACTION_MARKER = "Post-compaction context"

function wasCompactedAfterTrigger(lines: string[], triggerIndex: number): boolean {
  return lines.slice(triggerIndex + 1).some((l) => l.includes(POST_COMPACTION_MARKER))
}

function buildDenialReason(
  toolName: string,
  missingSkill: boolean,
  skillPath: string | null
): string {
  if (missingSkill) {
    return (
      `${SELF_SENTINEL}: ${toolName} is BLOCKED until you finish the required memory follow-through from an earlier hook response.\n\n` +
      formatActionPlan(
        [
          `Read the /${UPDATE_MEMORY_SKILL} skill directly: ${skillPath ?? "open its installed SKILL.md"}. If advisory setup fails, read without executing setup; keep runtime policy and mandatory checks, and report unavailable analysis as unknown.`,
          PROJECT_MEMORY_GUIDANCE,
        ],
        { header: "To resolve:" }
      ) +
      `\nThis gate clears automatically once the transcript shows both steps after the original reminder.` +
      `\n\nYou must act on this now. Do not try to stop again without completing the required action.`
    )
  }
  return (
    `${SELF_SENTINEL}: ${toolName} is BLOCKED until you record the required workflow rule in a markdown file.\n\n` +
    formatActionPlan([PROJECT_MEMORY_GUIDANCE], { header: "To resolve:" }) +
    `\nThis gate clears automatically once the transcript shows that markdown write after the original reminder.` +
    `\n\nYou must act on this now. Do not try to stop again without completing the required action.`
  )
}

async function shouldSkipEnforcement(
  input: Record<string, unknown>,
  cwd: string,
  transcriptPath: string,
  toolName: string
): Promise<boolean> {
  if (!transcriptPath || !toolName) return true
  if (!(await isGitRepoForHookPayload(input, cwd))) return true
  const location = await resolveProjectMemory(cwd)
  return !location || !(await Bun.file(location.rules).exists())
}

async function shouldSkipAfterTrigger(
  lines: string[],
  triggerIndex: number,
  cwd: string,
  sessionId: string | undefined
): Promise<boolean> {
  if (wasCompactedAfterTrigger(lines, triggerIndex)) return true
  if (await isMemoryRecentlyUpdated(cwd)) return true
  return await hasActiveTask(sessionId)
}

function isCurrentToolSatisfying(
  state: EnforcementState,
  toolName: string,
  toolInput: Record<string, any>,
  context: ToolSatisfactionContext
): boolean {
  if (state.skillReadComplete && state.markdownWriteComplete) return true
  if (
    !state.skillReadComplete &&
    toolLoadsSkill(toolName, toolInput, UPDATE_MEMORY_SKILL, context.skillPath)
  )
    return true
  return (
    !state.markdownWriteComplete &&
    toolWritesMarkdown(toolName, toolInput, context.cwd, context.location)
  )
}

function parseToolHookInput(raw: Record<string, any>): ToolHookInput | null {
  try {
    return toolHookInputSchema.parse(raw)
  } catch {
    return null
  }
}

async function getPendingReminderLines(
  input: Record<string, unknown>,
  transcriptPath: string,
  cwd: string,
  toolName: string
): Promise<{ lines: string[]; lastTriggerIndex: number } | null> {
  if (await shouldSkipEnforcement(input, cwd, transcriptPath, toolName)) return null

  const lines = (await resolveSessionLines(input, transcriptPath)).filter((line) => line.trim())
  if (lines.length === 0) return null

  const lastTriggerIndex = findLastTriggerIndex(lines)
  if (lastTriggerIndex < 0) return null

  return { lines, lastTriggerIndex }
}

function isAutoMemoryEdit(toolName: string, toolInput: unknown): boolean {
  if (!isWriteTool(toolName) && !isEditTool(toolName)) return false
  const paths = editPaths(toolInput)
  return paths.length > 0 && paths.every(isAutoMemoryPath)
}

function isReadOnlyDoctorTool(toolName: string, toolInput: unknown): boolean {
  if (!isShellTool(toolName) || typeof toolInput !== "object" || toolInput === null) return false
  const input = toolInput as { command?: unknown }
  return (
    typeof input.command === "string" &&
    ["swiz doctor", "swiz doctor --verbose"].includes(input.command)
  )
}

function shouldSkipCurrentTool(toolName: string, toolInput: Record<string, any>): boolean {
  return isReadOnlyDoctorTool(toolName, toolInput) || isAutoMemoryEdit(toolName, toolInput)
}

async function evaluatePendingMemoryReminder(
  input: ToolHookInput,
  pendingReminder: { lines: string[]; lastTriggerIndex: number },
  cwd: string,
  toolName: string,
  toolInput: Record<string, any>
): Promise<SwizHookOutput> {
  const { lines, lastTriggerIndex } = pendingReminder
  if (await shouldSkipAfterTrigger(lines, lastTriggerIndex, cwd, input.session_id)) return {}
  const location = await resolveProjectMemory(cwd)
  if (!location) return {}

  const skillPath = resolveSkillFilePathForHookPayload(UPDATE_MEMORY_SKILL, input, cwd)
  const { recencyOptions } = await resolveSkillRecencyOptions(cwd)
  const calls = getSuccessfulToolCalls(lines.slice(lastTriggerIndex + 1), input, recencyOptions)
  const state: EnforcementState = {
    skillReadComplete: calls.some((call) =>
      toolLoadsSkill(call.name ?? "", call.input, UPDATE_MEMORY_SKILL, skillPath)
    ),
    markdownWriteComplete: calls.some((call) =>
      toolWritesMarkdown(call.name ?? "", call.input, cwd, location)
    ),
  }
  if (
    isCurrentToolSatisfying(state, toolName, toolInput, {
      skillPath,
      cwd,
      location,
    })
  )
    return {}
  return preToolUseDeny(buildDenialReason(toolName, !state.skillReadComplete, skillPath))
}

export async function evaluatePretooluseUpdateMemoryEnforcement(
  raw: Record<string, any>
): Promise<SwizHookOutput> {
  const input = parseToolHookInput(raw)
  if (!input) return {}

  const transcriptPath = input.transcript_path ?? ""
  const toolName = input.tool_name ?? ""
  const toolInput = input.tool_input ?? {}
  const cwd = input.cwd ?? process.cwd()
  // The recommended read-only diagnostic and built-in memory writes stay exempt
  // while this gate is active.
  if (shouldSkipCurrentTool(toolName, toolInput)) return {}

  const pendingReminder = await getPendingReminderLines(
    input as Record<string, unknown>,
    transcriptPath,
    cwd,
    toolName
  )
  if (!pendingReminder) return {}
  return await evaluatePendingMemoryReminder(input, pendingReminder, cwd, toolName, toolInput)
}

const pretooluseUpdateMemoryEnforcement: SwizToolHook = {
  name: "pretooluse-update-memory-enforcement",
  event: "preToolUse",
  timeout: 5,
  cooldownSeconds: 300,
  cooldownScope: "session",

  async run(input) {
    return await evaluatePretooluseUpdateMemoryEnforcement(input as Record<string, any>)
  },
}

export default pretooluseUpdateMemoryEnforcement

if (import.meta.main) {
  await runSwizHookAsMain(pretooluseUpdateMemoryEnforcement)
}
