#!/usr/bin/env bun
import {
  preToolUseDeny,
  runSwizHookAsMain,
  type SwizHookOutput,
  type SwizToolHook,
} from "../src/SwizHook.ts"
import { toolHookInputSchema } from "../src/schemas.ts"
import {
  isCodeChangeTool,
  isShellTool,
  isSkillTool,
  isTaskUpdateTool,
} from "../src/tool-matchers.ts"
import { readSessionLines } from "../src/utils/transcript.ts"

const WINDOW_MS = 20 * 60 * 1000
const EDIT_LIMIT = 8
const BASH_FAILURE_LIMIT = 3
const COMMAND_KEY_LENGTH = 60
const UNBLOCK_SKILL = ["un", "block-myself"].join("")

type StuckSignal =
  | { type: "file"; message: string }
  | { type: "bash"; message: string }
  | { type: "idle"; message: string }

interface ToolResult {
  isError: boolean | null
  text: string
  timestampMs: number | null
  denied: boolean
}

interface TranscriptEvent {
  kind: "file" | "bash" | "progress" | "commit" | "skill"
  timestampMs: number | null
  filePath?: string
  commandKey?: string
  failed?: boolean
  skillName?: string
}

interface CurrentTool {
  kind: "file" | "bash"
  filePath?: string
  commandKey?: string
}

function parseTimestampMs(value: any): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value !== "string" || !value.trim()) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function textFromUnknown(value: any): string {
  if (typeof value === "string") return value
  if (Array.isArray(value)) return value.map(textFromUnknown).filter(Boolean).join("\n")
  if (!value || typeof value !== "object") return ""
  if (typeof value.text === "string") return value.text
  if (typeof value.content === "string") return value.content
  return ""
}

function parseLine(line: string): Record<string, any> | null {
  try {
    const parsed = JSON.parse(line)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function resultFromBlock(block: Record<string, any>, entryTimestampMs: number | null): ToolResult {
  const text = textFromUnknown(block.content)
  return {
    isError: typeof block.is_error === "boolean" ? block.is_error : null,
    text,
    timestampMs: parseTimestampMs(block.timestamp) ?? entryTimestampMs,
    denied: text.includes("You must act on this now") || text.includes("Resolve this block"),
  }
}

function collectResults(lines: string[]): Map<string, ToolResult> {
  const results = new Map<string, ToolResult>()
  for (const line of lines) {
    const entry = parseLine(line)
    if (!entry) continue
    const entryTimestampMs = parseTimestampMs(entry.timestamp ?? entry.created_at ?? entry.time)
    const content = entry.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if ((block as Record<string, any>)?.type !== "tool_result") continue
      const id = String((block as Record<string, any>).tool_use_id ?? "")
      if (id) results.set(id, resultFromBlock(block as Record<string, any>, entryTimestampMs))
    }
  }
  return results
}

function normalizeCommand(command: string): string {
  return command.normalize("NFKC").replace(/\s+/g, " ").trim()
}

export function commandKey(command: string): string {
  return normalizeCommand(command).slice(0, COMMAND_KEY_LENGTH)
}

function shellFailed(result: ToolResult | undefined): boolean {
  if (!result || result.denied) return false
  if (result.isError === true) return true
  return /\b(?:exit status|exit code|exited with code)\s+[1-9]\d*\b/i.test(result.text)
}

function shellSucceeded(result: ToolResult | undefined): boolean {
  if (!result || result.denied || shellFailed(result)) return false
  if (result.isError === false) return true
  return /\b(?:exit status|exit code|exited with code)\s+0\b/i.test(result.text)
}

function toolSucceeded(result: ToolResult | undefined): boolean {
  if (result?.denied || result?.isError === true) return false
  return true
}

function isCommitCommand(command: string): boolean {
  return /\bgit(?:\s+-C\s+\S+)?\s+commit\b/.test(normalizeCommand(command))
}

function filePathFromInput(input: Record<string, any> | undefined): string {
  return String(input?.file_path ?? input?.path ?? "")
}

function statusFromInput(input: Record<string, any> | undefined): string {
  return String(input?.status ?? "").toLowerCase()
}

function skillFromInput(input: Record<string, any> | undefined): string {
  return String(input?.skill ?? input?.name ?? "")
}

function resultTimestamp(
  entryTimestampMs: number | null,
  result: ToolResult | undefined
): number | null {
  return result?.timestampMs ?? entryTimestampMs
}

function appendShellEvents(
  events: TranscriptEvent[],
  block: Record<string, any>,
  result: ToolResult | undefined,
  entryTimestampMs: number | null
): void {
  const command = String((block.input as Record<string, any> | undefined)?.command ?? "")
  if (!command) return
  const timestampMs = resultTimestamp(entryTimestampMs, result)
  if (shellFailed(result)) {
    events.push({ kind: "bash", commandKey: commandKey(command), failed: true, timestampMs })
  }
  if (shellSucceeded(result)) {
    events.push({ kind: "progress", timestampMs })
    if (isCommitCommand(command)) events.push({ kind: "commit", timestampMs })
  }
}

function appendFileEvents(
  events: TranscriptEvent[],
  block: Record<string, any>,
  result: ToolResult | undefined,
  entryTimestampMs: number | null
): void {
  if (result?.denied) return
  const filePath = filePathFromInput(block.input as Record<string, any> | undefined)
  if (!filePath) return
  const timestampMs = resultTimestamp(entryTimestampMs, result)
  events.push({ kind: "file", filePath, timestampMs })
  if (toolSucceeded(result)) events.push({ kind: "progress", timestampMs })
}

function appendTaskEvents(
  events: TranscriptEvent[],
  block: Record<string, any>,
  result: ToolResult | undefined,
  entryTimestampMs: number | null
): void {
  if (!toolSucceeded(result)) return
  const status = statusFromInput(block.input as Record<string, any> | undefined)
  if (status === "completed" || status === "in_progress") {
    events.push({ kind: "progress", timestampMs: resultTimestamp(entryTimestampMs, result) })
  }
}

function appendSkillEvents(
  events: TranscriptEvent[],
  block: Record<string, any>,
  result: ToolResult | undefined,
  entryTimestampMs: number | null
): void {
  if (!toolSucceeded(result)) return
  const skillName = skillFromInput(block.input as Record<string, any> | undefined)
  if (skillName !== UNBLOCK_SKILL) return
  const timestampMs = resultTimestamp(entryTimestampMs, result)
  events.push({ kind: "skill", skillName, timestampMs })
  events.push({ kind: "progress", timestampMs })
}

function extractHumanSkillExpansions(entry: Record<string, any>): string[] {
  if (entry.type !== "human") return []
  const content = entry.message?.content
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((block) => textFromUnknown(block)).join("\n")
        : ""
  const skills: string[] = []
  for (const match of text.matchAll(/<command-name>([a-z][a-z0-9-]*)<\/command-name>/g)) {
    if (match[1]) skills.push(match[1])
  }
  return skills
}

export function parseStuckStateEvents(lines: string[]): TranscriptEvent[] {
  const results = collectResults(lines)
  const events: TranscriptEvent[] = []
  for (const line of lines) {
    const entry = parseLine(line)
    if (!entry) continue
    const entryTimestampMs = parseTimestampMs(entry.timestamp ?? entry.created_at ?? entry.time)

    for (const skillName of extractHumanSkillExpansions(entry)) {
      if (skillName === UNBLOCK_SKILL) {
        events.push({ kind: "skill", skillName, timestampMs: entryTimestampMs })
        events.push({ kind: "progress", timestampMs: entryTimestampMs })
      }
    }

    if (entry.type !== "assistant") continue
    const content = entry.message?.content
    if (!Array.isArray(content)) continue
    for (const rawBlock of content) {
      const block = rawBlock as Record<string, any>
      if (block.type !== "tool_use") continue
      const result = results.get(String(block.id ?? ""))
      const name = String(block.name ?? "")
      if (isShellTool(name)) appendShellEvents(events, block, result, entryTimestampMs)
      else if (isCodeChangeTool(name)) appendFileEvents(events, block, result, entryTimestampMs)
      else if (isTaskUpdateTool(name)) appendTaskEvents(events, block, result, entryTimestampMs)
      else if (isSkillTool(name)) appendSkillEvents(events, block, result, entryTimestampMs)
    }
  }
  return events
}

function resolveCurrentTool(input: {
  tool_name?: string
  tool_input?: Record<string, any>
}): CurrentTool | null {
  const toolName = input.tool_name ?? ""
  if (isShellTool(toolName)) {
    const command = String(input.tool_input?.command ?? "")
    return command ? { kind: "bash", commandKey: commandKey(command) } : null
  }
  if (isCodeChangeTool(toolName)) {
    const filePath = filePathFromInput(input.tool_input)
    return filePath ? { kind: "file", filePath } : null
  }
  return null
}

function maxTimestamp(events: TranscriptEvent[], kind: TranscriptEvent["kind"]): number | null {
  const times = events
    .filter((event) => event.kind === kind && event.timestampMs !== null)
    .map((event) => event.timestampMs as number)
  return times.length > 0 ? Math.max(...times) : null
}

function firstTimestamp(events: TranscriptEvent[]): number | null {
  const times = events
    .filter((event) => event.timestampMs !== null)
    .map((event) => event.timestampMs as number)
  return times.length > 0 ? Math.min(...times) : null
}

function minutesSince(nowMs: number, thenMs: number): number {
  return Math.max(0, Math.floor((nowMs - thenMs) / 60_000))
}

function recentAfterReset(
  event: TranscriptEvent,
  nowMs: number,
  resetMs: number,
  windowed: boolean
): boolean {
  if (event.timestampMs === null) return false
  if (event.timestampMs <= resetMs) return false
  return !windowed || nowMs - event.timestampMs <= WINDOW_MS
}

function detectFileLoop(
  events: TranscriptEvent[],
  current: CurrentTool,
  nowMs: number,
  resetMs: number
): StuckSignal | null {
  if (current.kind !== "file" || !current.filePath) return null
  const count = events.filter(
    (event) =>
      event.kind === "file" &&
      event.filePath === current.filePath &&
      recentAfterReset(event, nowMs, resetMs, true)
  ).length
  if (count < EDIT_LIMIT) return null
  return {
    type: "file",
    message: `same file edited ${count + 1} times in 20 minutes without commit`,
  }
}

function detectBashLoop(
  events: TranscriptEvent[],
  current: CurrentTool,
  resetMs: number
): StuckSignal | null {
  if (current.kind !== "bash" || !current.commandKey) return null
  const count = events.filter(
    (event) =>
      event.kind === "bash" &&
      event.failed &&
      event.commandKey === current.commandKey &&
      (event.timestampMs ?? Number.POSITIVE_INFINITY) > resetMs
  ).length
  if (count < BASH_FAILURE_LIMIT) return null
  return { type: "bash", message: `same Bash command failed ${count + 1} times` }
}

function detectIdle(events: TranscriptEvent[], nowMs: number): StuckSignal | null {
  const lastProgressMs = maxTimestamp(events, "progress")
  const sinceMs = lastProgressMs ?? firstTimestamp(events)
  if (sinceMs === null || nowMs - sinceMs <= WINDOW_MS) return null
  return {
    type: "idle",
    message: `no forward progress in ${minutesSince(nowMs, sinceMs)} minutes`,
  }
}

export function detectStuckStateSignal(
  events: TranscriptEvent[],
  current: CurrentTool,
  nowMs: number
): StuckSignal | null {
  const lastCommitMs = maxTimestamp(events, "commit") ?? Number.NEGATIVE_INFINITY
  const lastSkillMs = maxTimestamp(events, "skill") ?? Number.NEGATIVE_INFINITY
  const resetMs = Math.max(lastCommitMs, lastSkillMs)
  return (
    detectFileLoop(events, current, nowMs, resetMs) ??
    detectBashLoop(events, current, resetMs) ??
    detectIdle(events, nowMs)
  )
}

function settingDisabled(input: Record<string, any>): boolean {
  return input._effectiveSettings?.enforceUnblockMyself === false
}

export async function evaluatePretooluseStuckState(input: object): Promise<SwizHookOutput> {
  const hookInput = toolHookInputSchema.parse(input)
  if (settingDisabled(hookInput)) return {}

  const current = resolveCurrentTool({
    tool_name: hookInput.tool_name,
    tool_input: hookInput.tool_input as Record<string, any> | undefined,
  })
  if (!current) return {}

  const transcriptPath = hookInput.transcript_path ?? ""
  if (!transcriptPath) return {}

  const lines = await readSessionLines(transcriptPath)
  if (lines.length === 0) return {}

  const events = parseStuckStateEvents(lines)
  const nowMs =
    typeof hookInput._testNowMs === "number" && Number.isFinite(hookInput._testNowMs)
      ? hookInput._testNowMs
      : Date.now()
  const signal = detectStuckStateSignal(events, current, nowMs)
  if (!signal) return {}

  return preToolUseDeny(
    `Stuck-state detected: ${signal.message} - run /${UNBLOCK_SKILL} before continuing this approach.`
  )
}

const pretooluseStuckState: SwizToolHook = {
  name: "pretooluse-stuck-state",
  event: "preToolUse",
  matcher: "Edit|Write|Bash",
  timeout: 5,
  cooldownSeconds: 600,
  requiredSettings: ["enforceUnblockMyself"],
  run(input) {
    return evaluatePretooluseStuckState(input)
  },
}

export default pretooluseStuckState

if (import.meta.main) {
  await runSwizHookAsMain(pretooluseStuckState)
}
