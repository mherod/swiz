#!/usr/bin/env bun
// PreToolUse hook: once a hook response instructs the agent to record an
// update-memory DO/DON'T rule, block normal work until the transcript shows:
//   1. The update-memory skill was read
//   2. A markdown file write was performed

import {
  denyPreToolUse,
  isEditTool,
  isNotebookTool,
  isShellTool,
  isWriteTool,
  type ToolHookInput,
} from "./hook-utils.ts"

const REMINDER_FRAGMENT =
  "record a DO or DON'T rule that proactively builds the required steps into your standard development workflow."
const SELF_SENTINEL = "MEMORY CAPTURE ENFORCEMENT"
const UPDATE_MEMORY_SKILL_PATH_FRAGMENT = "update-memory/SKILL.md"
const MARKDOWN_FILE_RE = /(?:^|[\\/])[^\\/\n]+\.md$/i
const APPLY_PATCH_MARKDOWN_RE = /^\*\*\* (?:Add|Update) File: .+\.md$/m

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
  const mentionsSkill = strings.some((value) => value.includes(UPDATE_MEMORY_SKILL_PATH_FRAGMENT))
  if (!mentionsSkill) return false

  // Any explicit skill-path access counts, but bash must still actually target
  // the skill path to avoid unrelated work slipping through.
  if (isShellTool(toolName)) return true
  return true
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

function scanTranscript(lines: string[], startIndex: number): EnforcementState {
  const state: EnforcementState = {
    skillReadComplete: false,
    markdownWriteComplete: false,
  }

  for (let i = startIndex + 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line) continue

    try {
      const entry = JSON.parse(line)
      if (entry?.type !== "assistant") continue
      const content = entry?.message?.content
      if (!Array.isArray(content)) continue

      for (const block of content) {
        if (block?.type !== "tool_use" || !block?.name) continue

        const name = String(block.name)
        const input = block.input

        if (!state.skillReadComplete && toolReadsUpdateMemorySkill(name, input)) {
          state.skillReadComplete = true
        }
        if (!state.markdownWriteComplete && toolWritesMarkdown(name, input)) {
          state.markdownWriteComplete = true
        }

        if (state.skillReadComplete && state.markdownWriteComplete) {
          return state
        }
      }
    } catch {
      // Ignore malformed transcript lines.
    }
  }

  return state
}

async function main(): Promise<void> {
  const input = (await Bun.stdin.json()) as ToolHookInput
  const transcriptPath = input.transcript_path ?? ""
  const toolName = input.tool_name ?? ""
  const toolInput = input.tool_input ?? {}

  if (!transcriptPath || !toolName) return

  let transcriptText = ""
  try {
    transcriptText = await Bun.file(transcriptPath).text()
  } catch {
    return
  }
  if (!transcriptText.trim()) return

  const lines = transcriptText.split("\n").filter((line) => line.trim())
  let lastTriggerIndex = -1

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line) continue
    if (line.includes(REMINDER_FRAGMENT) && !line.includes(SELF_SENTINEL)) {
      lastTriggerIndex = i
      break
    }
  }

  if (lastTriggerIndex < 0) return

  const state = scanTranscript(lines, lastTriggerIndex)
  if (state.skillReadComplete && state.markdownWriteComplete) return

  if (!state.skillReadComplete && toolReadsUpdateMemorySkill(toolName, toolInput)) return
  if (
    state.skillReadComplete &&
    !state.markdownWriteComplete &&
    toolWritesMarkdown(toolName, toolInput)
  ) {
    return
  }

  const missingSkill = !state.skillReadComplete
  const reason = missingSkill
    ? `${SELF_SENTINEL}: ${toolName} is BLOCKED until you finish the required memory follow-through from an earlier hook response.\n\n` +
      `Required now:\n` +
      `1. Read the /update-memory skill by opening its SKILL.md.\n` +
      `2. Write the resulting DO or DON'T rule into a project markdown file such as CLAUDE.md.\n\n` +
      `This gate clears automatically once the transcript shows both steps after the original reminder.`
    : `${SELF_SENTINEL}: ${toolName} is BLOCKED until you record the required workflow rule in a markdown file.\n\n` +
      `Required now:\n` +
      `1. Write the DO or DON'T rule into a project markdown file such as CLAUDE.md.\n\n` +
      `This gate clears automatically once the transcript shows that markdown write after the original reminder.`

  denyPreToolUse(reason)
}

await main()
