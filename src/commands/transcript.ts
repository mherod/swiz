import { join, resolve } from "node:path"
import { format } from "date-fns"
import { orderBy } from "lodash-es"
import { AGENTS, type AgentDef } from "../agents.ts"
import { BOLD, CYAN, DIM, GREEN, RED, RESET, YELLOW } from "../ansi.ts"
import { detectCurrentAgent } from "../detect.ts"
import { getHomeDirOrNull } from "../home.ts"
import { getTranscriptProvidersForAgent, type TranscriptProviderId } from "../provider-adapters.ts"
import {
  type ContentBlock,
  extractText,
  extractTextFromUnknownContent,
  findAllProviderSessions,
  getUnsupportedTranscriptFormatMessage,
  isHookFeedback as isHookFeedbackContent,
  isTextBlockWithText,
  isUnsupportedTranscriptFormat,
  parseTranscriptEntries,
  type Session,
  type TextBlock,
  type ToolResultBlock,
  type ToolUseBlock,
  type TranscriptEntry,
  toolUseBlockSchema,
} from "../transcript-utils.ts"
import type { Command } from "../types.ts"

// ─── Tool-use label formatting ────────────────────────────────────────────────

const TOOL_KEY_PARAM: Record<string, string> = {
  Read: "file_path",
  Write: "file_path",
  Edit: "file_path",
  Bash: "command",
  Shell: "command",
  run_shell_command: "command",
  shell_command: "command",
  exec_command: "command",
  Glob: "pattern",
  Grep: "pattern",
  WebFetch: "url",
  WebSearch: "query",
}

const TOOL_LABEL_MAX = 70
const DEFAULT_COLUMNS = 80
const DEFAULT_WRAP_MAX = 100
const DEBUG_WRAP_MAX = 130
const SESSION_RULE_WIDTH = 60

function truncateLabel(value: string, max = TOOL_LABEL_MAX): string {
  return value.slice(0, max)
}

function formatToolUse(name: string, input: Record<string, unknown>): string {
  // Task tool: use subagent_type as name, description as param
  if (name === "Task" && input.subagent_type) {
    const desc = typeof input.description === "string" ? truncateLabel(input.description) : ""
    return `${input.subagent_type}(${desc})`
  }
  const param = TOOL_KEY_PARAM[name]
  if (param && input[param] !== undefined) {
    // Preserve full shell commands in transcript output so users can inspect
    // policy-relevant tokens that may appear near the end.
    if (param === "command") return `${name}(${String(input[param])})`
    return `${name}(${truncateLabel(String(input[param]))})`
  }
  // Fallback: first string value in input
  const firstStr = Object.values(input).find((v) => typeof v === "string")
  if (firstStr) return `${name}(${truncateLabel(String(firstStr))})`
  return name
}

// ─── Rendering ───────────────────────────────────────────────────────────────

import { createOpenRouter } from "@openrouter/ai-sdk-provider"
import { generateText, type ModelMessage } from "ai"
/**
 * Strip ANSI escape sequences so wordWrap measures visual width correctly.
 * Debug log lines can embed ANSI colour codes (e.g. ESC[33mpendingESC[0m).
 * Uses String.fromCharCode(27) to avoid the no-control-regex Biome lint rule.
 */
import { stripAnsi } from "../utils/transcript.ts"

function getWrapWidth(indentWidth: number, maxWidth = DEFAULT_WRAP_MAX): number {
  const cols = process.stdout.columns ?? DEFAULT_COLUMNS
  return Math.min(cols - indentWidth, maxWidth)
}

function toContentBlocks(content: string | ContentBlock[] | undefined): ContentBlock[] {
  if (!content) return []
  return typeof content === "string" ? [{ type: "text", text: content }] : content
}

function isVisibleTextBlock(block: ContentBlock): block is TextBlock & { text: string } {
  return isTextBlockWithText(block) && block.text.trim().length > 0
}

function isNamedToolUseBlock(block: ContentBlock): block is ToolUseBlock & { name: string } {
  const result = toolUseBlockSchema.safeParse(block)
  return result.success && typeof result.data.name === "string"
}

function hasVisibleAssistantContent(blocks: ContentBlock[]): boolean {
  return blocks.some((block) => isVisibleTextBlock(block) || isNamedToolUseBlock(block))
}

function hasToolResults(content: string | ContentBlock[] | undefined): boolean {
  return Array.isArray(content) && content.some((block) => block.type === "tool_result")
}

function wordWrap(text: string, width: number, indent: string): string {
  const lines: string[] = []
  for (const paragraph of text.split("\n")) {
    if (paragraph.length === 0) {
      lines.push("")
      continue
    }
    let current = ""
    for (const word of paragraph.split(" ")) {
      if (current.length === 0) {
        current = word
      } else if (current.length + 1 + word.length <= width) {
        current += ` ${word}`
      } else {
        lines.push(indent + current)
        current = word
      }
    }
    if (current) lines.push(indent + current)
  }
  return lines.join("\n")
}

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return ""
    return format(d, "HH:mm")
  } catch {
    return ""
  }
}

function renderTurn(role: "user" | "assistant", text: string, timestamp?: string): void {
  if (!text.trim()) return

  const isUser = role === "user"
  const label = isUser ? "USER" : "ASSISTANT"
  const color = isUser ? YELLOW : CYAN
  const ts = timestamp ? ` ${DIM}${formatTimestamp(timestamp)}${RESET}` : ""

  console.log(`\n${color}${BOLD}${label}${RESET}${ts}`)

  const wrapWidth = getWrapWidth(4)
  const wrapped = wordWrap(text.trim(), wrapWidth, "  ")
  console.log(wrapped)
}

function renderAssistantBlocks(entry: TranscriptEntry): boolean {
  const blocks = toContentBlocks(entry.message?.content)
  if (!hasVisibleAssistantContent(blocks)) return false

  const ts = entry.timestamp ? ` ${DIM}${formatTimestamp(entry.timestamp)}${RESET}` : ""
  console.log(`\n${CYAN}${BOLD}ASSISTANT${RESET}${ts}`)

  const wrapWidth = getWrapWidth(4)

  for (const block of blocks) {
    if (isVisibleTextBlock(block)) {
      console.log(wordWrap(block.text.trim(), wrapWidth, "  "))
      continue
    }
    if (isNamedToolUseBlock(block)) {
      const label = formatToolUse(block.name, block.input ?? {})
      console.log(`  ${GREEN}⏺${RESET} ${DIM}${label}${RESET}`)
    }
  }

  return true
}

const TOOL_RESULT_MAX = 600

function renderToolResults(entry: TranscriptEntry): boolean {
  const content = entry.message?.content
  if (!Array.isArray(content)) return false

  const results = content.filter((b): b is ToolResultBlock => b.type === "tool_result")
  if (results.length === 0) return false

  const wrapWidth = getWrapWidth(6)

  for (const result of results) {
    const text = extractTextFromUnknownContent(result.content)
    if (!text) continue

    const truncated =
      text.length > TOOL_RESULT_MAX
        ? `${text.slice(0, TOOL_RESULT_MAX)}\n  ${DIM}… (truncated)${RESET}`
        : text

    const indicator = result.is_error ? `${RED}✗${RESET}` : `${DIM}│${RESET}`
    const wrapped = wordWrap(truncated, wrapWidth, "    ")
    console.log(`  ${indicator} ${DIM}${wrapped}${RESET}`)
  }

  return true
}

// ─── Turn collection ─────────────────────────────────────────────────────────

interface Turn {
  entry: TranscriptEntry
  role: "user" | "assistant"
}

function cloneUserEntryWithPlainText(entry: TranscriptEntry, text: string): TranscriptEntry {
  return {
    ...entry,
    message: {
      ...entry.message,
      role: "user",
      content: text,
    },
  }
}

function hasVisibleContent(entry: TranscriptEntry, text: string): boolean {
  if (entry.type === "assistant") {
    return hasVisibleAssistantContent(toContentBlocks(entry.message?.content))
  }
  return hasToolResults(entry.message?.content) || text.length > 0
}

function collectUserTurns(entries: TranscriptEntry[]): Turn[] {
  const turns: Turn[] = []
  for (const entry of entries) {
    if (entry.type !== "user" || !entry.message) continue
    const text = extractText(entry.message.content).trim()
    if (!text || isHookFeedbackContent(text)) continue
    turns.push({ entry: cloneUserEntryWithPlainText(entry, text), role: "user" })
  }
  return turns
}

function collectTurns(entries: TranscriptEntry[], userOnly = false): Turn[] {
  if (userOnly) return collectUserTurns(entries)
  const turns: Turn[] = []
  for (const entry of entries) {
    if (entry.type !== "user" && entry.type !== "assistant") continue
    if (!entry.message) continue
    const text = extractText(entry.message.content).trim()
    if (entry.type === "user" && isHookFeedbackContent(text)) continue
    if (!hasVisibleContent(entry, text)) continue
    turns.push({ entry, role: entry.type as "user" | "assistant" })
  }
  return turns
}

// ─── Turn loading ─────────────────────────────────────────────────────────────

async function loadTurns(session: Session, userOnly = false): Promise<Turn[]> {
  if (isUnsupportedTranscriptFormat(session.format)) {
    throw new Error(getUnsupportedTranscriptFormatMessage(session))
  }

  const file = Bun.file(session.path)
  if (!(await file.exists())) {
    throw new Error(`Transcript not found: ${session.path}`)
  }
  const text = await file.text()
  return collectTurns(parseTranscriptEntries(text, session.format), userOnly)
}

interface DebugLog {
  path: string
  lines: string[]
}

interface DebugEvent {
  iso: string
  ts: number
  text: string
}

const DEBUG_TS_RE = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s+/

async function loadDebugLog(sessionId: string): Promise<DebugLog | null> {
  const home = getHomeDirOrNull()
  if (!home) return null

  const path = join(home, ".claude", "debug", `${sessionId}.txt`)
  const file = Bun.file(path)
  if (!(await file.exists())) return null

  const text = await file.text()
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)

  return { path, lines }
}

type TaggedDebugEvent = DebugEvent & { _idx: number; _malformed: boolean; _seq: number }

function classifyDebugLine(
  line: string,
  idx: number,
  validEvents: TaggedDebugEvent[],
  malformedEvents: TaggedDebugEvent[],
  allEvents: TaggedDebugEvent[]
): void {
  const m = DEBUG_TS_RE.exec(line)
  if (!m) {
    const prev = allEvents[allEvents.length - 1]
    if (prev) {
      prev.text += `\n${line}`
    } else {
      const tagged: TaggedDebugEvent = {
        iso: "",
        ts: 0,
        text: line,
        _idx: idx,
        _malformed: true,
        _seq: malformedEvents.length,
      }
      malformedEvents.push(tagged)
      allEvents.push(tagged)
    }
    return
  }
  const iso = m[1]
  if (iso === undefined) return
  const parsed = new Date(iso).getTime()
  const isMalformed = Number.isNaN(parsed)
  const tagged: TaggedDebugEvent = {
    iso,
    ts: isMalformed ? 0 : parsed,
    text: line.slice(m[0].length),
    _idx: idx,
    _malformed: isMalformed,
    _seq: isMalformed ? malformedEvents.length : 0,
  }
  ;(isMalformed ? malformedEvents : validEvents).push(tagged)
  allEvents.push(tagged)
}

function normalizeMalformedEvents(events: TaggedDebugEvent[]): void {
  for (const ev of events) {
    if (typeof ev.iso !== "string") ev.iso = ""
    if (typeof ev._idx !== "number" || !Number.isFinite(ev._idx)) ev._idx = 0
    if (typeof ev._seq !== "number" || !Number.isFinite(ev._seq)) ev._seq = 0
  }
}

function mergeValidAndMalformed(
  sortedValid: TaggedDebugEvent[],
  sortedMalformed: TaggedDebugEvent[]
): TaggedDebugEvent[] {
  const result: TaggedDebugEvent[] = []
  let vi = 0
  for (const malformed of sortedMalformed) {
    while (vi < sortedValid.length && (sortedValid[vi]?._idx ?? Infinity) < malformed._idx) {
      result.push(sortedValid[vi]!)
      vi++
    }
    result.push(malformed)
  }
  while (vi < sortedValid.length) {
    result.push(sortedValid[vi]!)
    vi++
  }
  return result
}

function parseDebugEvents(lines: string[]): DebugEvent[] {
  const validEvents: TaggedDebugEvent[] = []
  const malformedEvents: TaggedDebugEvent[] = []
  const allEvents: TaggedDebugEvent[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined) continue
    classifyDebugLine(line, i, validEvents, malformedEvents, allEvents)
  }

  const sortedValid = orderBy(validEvents, [(ev) => ev.ts, (ev) => ev._idx], ["asc", "asc"])
  normalizeMalformedEvents(malformedEvents)
  const sortedMalformed = orderBy(
    malformedEvents,
    [(ev) => ev._idx ?? 0, (ev) => String(ev.iso ?? ""), (ev) => ev._seq ?? 0],
    ["asc", "asc", "asc"]
  )

  return mergeValidAndMalformed(sortedValid, sortedMalformed).map(({ iso, ts, text }) => ({
    iso,
    ts,
    text,
  }))
}

function renderDebugLine(event: DebugEvent): void {
  const wrapWidth = getWrapWidth(8, DEBUG_WRAP_MAX)
  const ts = formatTimestamp(event.iso)
  // Strip ANSI before wordWrap so byte-length matches visual width.
  // Embedded colour codes (e.g. ESC[33mpendingESC[0m) would otherwise
  // make wordWrap over-estimate line width and wrap too early.
  const wrapped = wordWrap(stripAnsi(event.text), wrapWidth, "  │        ")
  console.log(`  ${DIM}│ ${ts} ${wrapped}${RESET}`)
}

function applyHeadTail<T>(
  values: T[],
  headCount: number | undefined,
  tailCount: number | undefined
): T[] {
  if (tailCount !== undefined) return values.slice(-tailCount)
  if (headCount !== undefined) return values.slice(0, headCount)
  return values
}

// ─── Time filtering ─────────────────────────────────────────────────────────

interface TimeRange {
  from?: number
  to?: number
}

function filterTurnsByTime(turns: Turn[], range: TimeRange): Turn[] {
  return turns.filter((t) => {
    const ts = t.entry.timestamp
    if (!ts) return false
    const ms = new Date(ts).getTime()
    if (!Number.isFinite(ms)) return false
    if (range.from !== undefined && ms < range.from) return false
    if (range.to !== undefined && ms > range.to) return false
    return true
  })
}

function filterDebugEventsByTime(events: DebugEvent[], range: TimeRange): DebugEvent[] {
  return events.filter((e) => {
    if (range.from !== undefined && e.ts < range.from) return false
    if (range.to !== undefined && e.ts > range.to) return false
    return true
  })
}

function filterSessionsByTime(sessions: Session[], range: TimeRange): Session[] {
  return sessions.filter((s) => {
    if (range.from !== undefined && s.mtime < range.from) return false
    if (range.to !== undefined && s.mtime > range.to) return false
    return true
  })
}

// ─── Main rendering ──────────────────────────────────────────────────────────

function renderSingleTurn(entry: TranscriptEntry, role: "user" | "assistant"): void {
  if (role === "assistant") {
    renderAssistantBlocks(entry)
  } else {
    const content = entry.message?.content
    if (hasToolResults(content)) {
      renderToolResults(entry)
    } else {
      renderTurn("user", extractText(content), entry.timestamp)
    }
  }
}

function renderTurns(turns: Turn[], sessionId: string, debugEvents?: DebugEvent[]): void {
  console.log(
    `\n${DIM}Session: ${sessionId}${RESET}\n${DIM}${"─".repeat(SESSION_RULE_WIDTH)}${RESET}`
  )

  let debugIdx = 0
  const debug = debugEvents ?? []

  const flushDebugUpTo = (untilTs: number): void => {
    while (debugIdx < debug.length && debug[debugIdx] && debug[debugIdx]!.ts <= untilTs) {
      renderDebugLine(debug[debugIdx]!)
      debugIdx++
    }
  }

  for (const { entry, role } of turns) {
    const turnTs = entry.timestamp ? new Date(entry.timestamp).getTime() : null
    if (turnTs !== null) flushDebugUpTo(turnTs)
    renderSingleTurn(entry, role)
  }

  while (debugIdx < debug.length && debug[debugIdx]) {
    renderDebugLine(debug[debugIdx]!)
    debugIdx++
  }

  if (turns.length === 0) {
    console.log(`\n  ${DIM}(no conversation turns found)${RESET}\n`)
  } else {
    console.log(`\n${DIM}${"─".repeat(SESSION_RULE_WIDTH)}${RESET}\n`)
  }
}

// ─── Auto-reply generation ────────────────────────────────────────────────────

async function generateAutoReply(
  turns: Turn[],
  opts?: { sessionId?: string; flipRoles?: boolean }
): Promise<void> {
  // Build a plain-text representation of the conversation for LLM context
  const messages: ModelMessage[] = []
  const lines: string[] = []
  for (const { entry, role } of turns) {
    if (role === "user") {
      const text = extractText(entry.message?.content).trim()
      if (text) {
        lines.push(`User: ${text}\n`)
        messages.push({
          role: opts?.flipRoles ? "assistant" : "user",
          content: text,
        })
      }
    } else {
      const blocks = toContentBlocks(entry.message?.content)
      const textParts = blocks.filter(isVisibleTextBlock).map((b) => b.text.trim())
      if (textParts.length > 0) {
        lines.push(`Assistant: ${textParts.join("\n")}\n`)
        messages.push({
          role: opts?.flipRoles ? "user" : "assistant",
          content: textParts.join("\n"),
        })
      }
    }
  }

  const provider = createOpenRouter()
  const { response } = await generateText({
    model: provider.languageModel("stepfun/step-3.5-flash"),
    // model: claudeCode("haiku", {
    //   strictMcpConfig: true,
    //   mcpServers: {},
    // }),
    messages: messages.slice(-5),
    system: [
      "You are providing a follow-up directive to ensure the assistant can continue making confident progress.",
      "Your follow-up should be written as a direct instruction in the second person tense (You Must, You Should, You May), or if referring to us both, the first person tense (We, Our, Us).",
    ].join(),
  })

  const messageReplies = response.messages
    .filter((m) => "content" in m)
    .flatMap((m: { content: unknown }) => {
      return Array.isArray(m.content) ? m.content : [m.content]
    })
    .filter((m) => m.type === "text")
    .map((m) => m.text)
    .join("\n")

  console.log(messageReplies)
}

// ─── Arg Parsing ─────────────────────────────────────────────────────────────

export interface TranscriptArgs {
  sessionQuery: string | null
  targetDir: string
  listOnly: boolean
  headCount: number | undefined
  tailCount: number | undefined
  hours: number | undefined
  since: number | undefined
  until: number | undefined
  autoReply: boolean
  includeDebug: boolean
  userOnly: boolean
  allAgents: boolean
  explicitAgents: AgentDef[]
}

function consumeValueArg(
  args: string[],
  i: number,
  longFlag: string,
  shortFlag: string
): { value: string; skip: boolean } | null {
  const arg = args[i]
  if (arg !== longFlag && arg !== shortFlag) return null
  const next = args[i + 1]
  return next ? { value: next, skip: true } : null
}

const TRANSCRIPT_BOOLEAN_FLAGS: Record<string, string> = {
  "--list": "listOnly",
  "-l": "listOnly",
  "--auto-reply": "autoReply",
  "--include-debug": "includeDebug",
  "--user-only": "userOnly",
  "--all": "allAgents",
}

type ValueArgDef = [longFlag: string, shortFlag: string]

const TRANSCRIPT_VALUE_ARGS: ValueArgDef[] = [
  ["--session", "-s"],
  ["--dir", "-d"],
  ["--head", "-H"],
  ["--tail", "-T"],
  ["--hours", "-h"],
  ["--since", "-S"],
  ["--until", "-U"],
]

function parseTranscriptValueArgs(args: string[]): {
  flags: Record<string, boolean>
  values: Record<string, string>
} {
  const flags: Record<string, boolean> = {}
  const values: Record<string, string> = {}
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg) continue
    const flagKey = TRANSCRIPT_BOOLEAN_FLAGS[arg]
    if (flagKey) {
      flags[flagKey] = true
      continue
    }
    for (const [longFlag, shortFlag] of TRANSCRIPT_VALUE_ARGS) {
      const result = consumeValueArg(args, i, longFlag, shortFlag)
      if (result) {
        values[longFlag] = result.value
        i++
        break
      }
    }
  }
  return { flags, values }
}

function parseHoursValue(raw: string | undefined): number | undefined {
  if (!raw) return undefined
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Invalid --hours value: ${raw}. Must be a positive number.`)
  }
  return n
}

function parseDateValue(raw: string | undefined, flag: string): number | undefined {
  if (!raw) return undefined
  const ms = new Date(raw).getTime()
  if (!Number.isFinite(ms)) {
    throw new Error(
      `Invalid ${flag} value: ${raw}. Must be a valid date (e.g. 2026-03-12 or 2026-03-12T14:00:00).`
    )
  }
  return ms
}

function parseDateRange(
  sinceRaw: string | undefined,
  untilRaw: string | undefined
): { since: number | undefined; until: number | undefined } {
  const since = parseDateValue(sinceRaw, "--since")
  const until = parseDateValue(untilRaw, "--until")
  if (since !== undefined && until !== undefined && since > until) {
    throw new Error("--since must be before --until.")
  }
  return { since, until }
}

export function parseTranscriptArgs(args: string[]): TranscriptArgs {
  const { flags, values } = parseTranscriptValueArgs(args)
  const explicitAgents = AGENTS.filter((agent) => args.includes(`--${agent.id}`))
  const { since, until } = parseDateRange(values["--since"], values["--until"])
  return {
    sessionQuery: values["--session"] ?? null,
    targetDir: values["--dir"] ? resolve(values["--dir"]) : process.cwd(),
    listOnly: flags.listOnly ?? false,
    headCount: values["--head"] ? parseInt(values["--head"], 10) : undefined,
    tailCount: values["--tail"] ? parseInt(values["--tail"], 10) : undefined,
    hours: parseHoursValue(values["--hours"]),
    since,
    until,
    autoReply: flags.autoReply ?? false,
    includeDebug: flags.includeDebug ?? false,
    userOnly: flags.userOnly ?? false,
    allAgents: flags.allAgents ?? false,
    explicitAgents,
  }
}

function resolveSelectedAgents(
  allAgents: boolean,
  explicitAgents: AgentDef[],
  detectedAgent: AgentDef | null
): AgentDef[] {
  if (allAgents) return AGENTS
  if (explicitAgents[0]) return [explicitAgents[0]]
  if (detectedAgent) return [detectedAgent]
  return AGENTS
}

function getSelectedProviders(selectedAgents: AgentDef[]): Set<TranscriptProviderId> {
  const providers = new Set<TranscriptProviderId>()
  for (const agent of selectedAgents) {
    for (const provider of getTranscriptProvidersForAgent(agent)) {
      providers.add(provider)
    }
  }
  return providers
}

function pickSession(sessions: Session[], sessionQuery: string | null): Session {
  if (sessionQuery) {
    const match = sessions.find((session) => session.id.startsWith(sessionQuery))
    if (!match) {
      const available = sessions.map((session) => `  ${session.id}`).join("\n")
      throw new Error(`No session matching: ${sessionQuery}\nAvailable sessions:\n${available}`)
    }
    return match
  }
  return sessions.find((session) => !isUnsupportedTranscriptFormat(session.format)) ?? sessions[0]!
}

function renderSessionList(sessions: Session[], targetDir: string): void {
  console.log(`\n  Transcripts for ${targetDir}\n`)
  for (const session of sessions) {
    const label = format(new Date(session.mtime), "Pp")
    console.log(`  ${session.id}  ${DIM}${label}${RESET}`)
  }
  console.log()
}

function validateTranscriptArgs(parsed: TranscriptArgs): void {
  if (parsed.allAgents && parsed.explicitAgents.length > 0) {
    throw new Error("`--all` cannot be combined with an explicit agent flag.")
  }
  if (parsed.explicitAgents.length > 1) {
    throw new Error("Specify at most one agent: --claude, --cursor, --gemini, or --codex.")
  }
  if (parsed.userOnly && parsed.includeDebug) {
    throw new Error("`--user-only` cannot be combined with `--include-debug`.")
  }
  if (parsed.hours !== undefined && (parsed.since !== undefined || parsed.until !== undefined)) {
    throw new Error("`--hours` cannot be combined with `--since` or `--until`.")
  }
}

function validateProviders(providers: Set<TranscriptProviderId>, selectedAgents: AgentDef[]): void {
  if (providers.size === 0) {
    const agentLabel = selectedAgents[0]?.name ?? "selected agent"
    throw new Error(
      `${agentLabel} transcript discovery is not supported yet.\nUse --all or --claude/--gemini/--codex.`
    )
  }
}

async function loadFilteredSessions(
  targetDir: string,
  selectedProviders: Set<TranscriptProviderId>
): Promise<Session[]> {
  const allProviderSessions = await findAllProviderSessions(targetDir)
  const sessions = allProviderSessions.filter(
    (session) => !!session.provider && selectedProviders.has(session.provider)
  )
  if (sessions.length === 0) {
    const checkedProviders = [...selectedProviders].join(", ")
    throw new Error(
      `No transcripts found for: ${targetDir}\n(checked providers: ${checkedProviders})`
    )
  }
  return sessions
}

async function loadOptionalDebug(
  session: Session,
  parsed: TranscriptArgs
): Promise<DebugEvent[] | undefined> {
  if (!parsed.includeDebug) return undefined
  const debugFile = await loadDebugLog(session.id)
  if (!debugFile) {
    console.log(`\n${DIM}Debug log not found for session: ${session.id}${RESET}`)
    return undefined
  }
  return applyHeadTail(parseDebugEvents(debugFile.lines), parsed.headCount, parsed.tailCount)
}

// ─── Command ─────────────────────────────────────────────────────────────────

function buildTimeRange(parsed: ReturnType<typeof parseTranscriptArgs>): TimeRange {
  const from = parsed.hours ? Date.now() - parsed.hours * 3600_000 : parsed.since
  return { from, to: parsed.until }
}

async function loadSessionContent(
  session: Session,
  parsed: ReturnType<typeof parseTranscriptArgs>,
  timeRange: TimeRange,
  hasTimeFilter: boolean
) {
  let allTurns = await loadTurns(session, parsed.userOnly)
  if (hasTimeFilter) allTurns = filterTurnsByTime(allTurns, timeRange)
  const turns = applyHeadTail(allTurns, parsed.headCount, parsed.tailCount)
  let debugEvents = await loadOptionalDebug(session, parsed)
  if (debugEvents && hasTimeFilter) debugEvents = filterDebugEventsByTime(debugEvents, timeRange)
  return { turns, debugEvents }
}

export const transcriptCommand: Command = {
  name: "transcript",
  description: "Display Agent-User chat history for the current project",
  usage:
    "swiz transcript [--session <id>] [--dir <path>] [--list] [--head N] [--tail N] [--hours N] [--since DATE] [--until DATE] [--auto-reply] [--include-debug] [--user-only] [--all|--claude|--cursor|--gemini|--codex]",
  options: [
    { flags: "--session, -s <id>", description: "Show a specific session (prefix match)" },
    { flags: "--dir, -d <path>", description: "Target project directory (default: cwd)" },
    { flags: "--list, -l", description: "List available sessions without displaying content" },
    { flags: "--head, -H <n>", description: "Show only the first N conversation turns" },
    { flags: "--tail, -T <n>", description: "Show only the last N conversation turns" },
    {
      flags: "--hours, -h <n>",
      description: "Limit output to sessions and turns from the last N hours",
    },
    {
      flags: "--since, -S <date>",
      description: "Show only sessions and turns after this date (e.g. 2026-03-12)",
    },
    {
      flags: "--until, -U <date>",
      description: "Show only sessions and turns before this date (e.g. 2026-03-13)",
    },
    { flags: "--auto-reply", description: "Generate an AI-suggested follow-up message" },
    {
      flags: "--user-only",
      description: "Show only user prompts/messages for the selected session",
    },
    {
      flags: "--include-debug",
      description:
        "Read ~/.claude/debug/<sessionId>.txt and interleave debug events inline with conversation turns, ordered by ISO timestamp. Each debug line is rendered as a dimmed │ HH:MM prefixed entry between the turns it falls between.",
    },
    {
      flags: "--all",
      description:
        "Show sessions from all providers (default when no agent context is detected and no agent flag is provided)",
    },
    { flags: "--claude", description: "Show Claude sessions only" },
    { flags: "--cursor", description: "Show Cursor sessions only (currently unsupported)" },
    { flags: "--gemini", description: "Show Gemini/Antigravity sessions only" },
    { flags: "--codex", description: "Show Codex sessions only" },
  ],
  async run(args: string[]) {
    const parsed = parseTranscriptArgs(args)
    validateTranscriptArgs(parsed)

    const selectedAgents = resolveSelectedAgents(
      parsed.allAgents,
      parsed.explicitAgents,
      detectCurrentAgent()
    )
    const selectedProviders = getSelectedProviders(selectedAgents)
    validateProviders(selectedProviders, selectedAgents)

    const timeRange = buildTimeRange(parsed)
    const hasTimeFilter = timeRange.from !== undefined || timeRange.to !== undefined

    let sessions = await loadFilteredSessions(parsed.targetDir, selectedProviders)
    if (hasTimeFilter) sessions = filterSessionsByTime(sessions, timeRange)
    if (sessions.length === 0 && hasTimeFilter) {
      console.log(`\n  ${DIM}No sessions found within the specified time range.${RESET}\n`)
      return
    }
    if (parsed.listOnly) {
      renderSessionList(sessions, parsed.targetDir)
      return
    }

    const session = pickSession(sessions, parsed.sessionQuery)
    const { turns, debugEvents } = await loadSessionContent(
      session,
      parsed,
      timeRange,
      hasTimeFilter
    )

    if (parsed.autoReply) {
      await generateAutoReply(turns, {
        sessionId: session.id,
        flipRoles: true,
      })
    } else renderTurns(turns, session.id, debugEvents)
  },
}
