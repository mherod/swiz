import { join, resolve } from "node:path"
import { promptAgent } from "../agent.ts"
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
  isUnsupportedTranscriptFormat,
  parseTranscriptEntries,
  type Session,
  type TextBlock,
  type ToolResultBlock,
  type ToolUseBlock,
  type TranscriptEntry,
} from "../transcript-utils.ts"
import type { Command } from "../types.ts"

// ─── Tool-use label formatting ────────────────────────────────────────────────

const TOOL_KEY_PARAM: Record<string, string> = {
  Read: "file_path",
  Write: "file_path",
  Edit: "file_path",
  Bash: "command",
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
    return `${name}(${truncateLabel(String(input[param]))})`
  }
  // Fallback: first string value in input
  const firstStr = Object.values(input).find((v) => typeof v === "string")
  if (firstStr) return `${name}(${truncateLabel(String(firstStr))})`
  return name
}

// ─── Rendering ───────────────────────────────────────────────────────────────

/**
 * Strip ANSI escape sequences so wordWrap measures visual width correctly.
 * Debug log lines can embed ANSI colour codes (e.g. ESC[33mpendingESC[0m).
 * Uses String.fromCharCode(27) to avoid the no-control-regex Biome lint rule.
 */
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[a-zA-Z]`, "g")
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "")
}

function getWrapWidth(indentWidth: number, maxWidth = DEFAULT_WRAP_MAX): number {
  const cols = process.stdout.columns ?? DEFAULT_COLUMNS
  return Math.min(cols - indentWidth, maxWidth)
}

function toContentBlocks(content: string | ContentBlock[] | undefined): ContentBlock[] {
  if (!content) return []
  return typeof content === "string" ? [{ type: "text", text: content }] : content
}

function isVisibleTextBlock(block: ContentBlock): block is TextBlock {
  const text = (block as TextBlock).text
  return block.type === "text" && typeof text === "string" && text.trim().length > 0
}

function isNamedToolUseBlock(block: ContentBlock): block is ToolUseBlock {
  return block.type === "tool_use" && typeof (block as ToolUseBlock).name === "string"
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
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
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
      console.log(wordWrap(block.text!.trim(), wrapWidth, "  "))
      continue
    }
    if (isNamedToolUseBlock(block)) {
      const label = formatToolUse(block.name!, block.input ?? {})
      console.log(`  ${GREEN}⏺${RESET} ${DIM}${label}${RESET}`)
    }
  }

  return true
}

const TOOL_RESULT_MAX = 600

function extractToolResultContent(block: ToolResultBlock): string {
  return extractTextFromUnknownContent(block.content)
}

function renderToolResults(entry: TranscriptEntry): boolean {
  const content = entry.message?.content
  if (!Array.isArray(content)) return false

  const results = content.filter((b): b is ToolResultBlock => b.type === "tool_result")
  if (results.length === 0) return false

  const wrapWidth = getWrapWidth(6)

  for (const result of results) {
    const text = extractToolResultContent(result)
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

function collectTurns(entries: TranscriptEntry[]): Turn[] {
  const turns: Turn[] = []
  for (const entry of entries) {
    if (entry.type !== "user" && entry.type !== "assistant") continue
    const msg = entry.message
    if (!msg) continue

    // Skip hook feedback injected as user messages
    if (
      entry.type === "user" &&
      typeof msg.content === "string" &&
      (msg.content.startsWith("Stop hook feedback:") || msg.content.startsWith("<command-message>"))
    ) {
      continue
    }

    // Skip turns that would render nothing
    if (entry.type === "assistant") {
      const blocks = toContentBlocks(entry.message?.content)
      if (!hasVisibleAssistantContent(blocks)) continue
    } else {
      const content = msg.content
      if (!hasToolResults(content) && !extractText(content).trim()) continue
    }

    turns.push({ entry, role: entry.type as "user" | "assistant" })
  }
  return turns
}

// ─── Turn loading ─────────────────────────────────────────────────────────────

async function loadTurns(session: Session): Promise<Turn[]> {
  if (isUnsupportedTranscriptFormat(session.format)) {
    throw new Error(getUnsupportedTranscriptFormatMessage(session))
  }

  const file = Bun.file(session.path)
  if (!(await file.exists())) {
    throw new Error(`Transcript not found: ${session.path}`)
  }
  const text = await file.text()
  return collectTurns(parseTranscriptEntries(text, session.format))
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

function parseDebugEvents(lines: string[]): DebugEvent[] {
  // _seq is the insertion index into the malformed array — used as the final sort tie-breaker
  // so the comparator is provably total-ordered even when _idx and iso both match.
  type Tagged = DebugEvent & { _idx: number; _malformed: boolean; _seq: number }

  const validEvents: Tagged[] = []
  const malformedEvents: Tagged[] = []
  const allEvents: Tagged[] = []

  const pushTaggedEvent = (
    event: Omit<Tagged, "_malformed" | "_seq"> & { malformed?: boolean }
  ): Tagged => {
    const tagged: Tagged = {
      ...event,
      _malformed: Boolean(event.malformed),
      _seq: event.malformed ? malformedEvents.length : 0,
    }
    if (tagged._malformed) {
      malformedEvents.push(tagged)
    } else {
      validEvents.push(tagged)
    }
    allEvents.push(tagged)
    return tagged
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined) continue
    const m = DEBUG_TS_RE.exec(line)
    if (!m) {
      // Continuation line (no ISO prefix): attach to the preceding event so no text is lost.
      const prev = allEvents[allEvents.length - 1]
      if (prev) {
        prev.text += `\n${line}`
      } else {
        // Leading continuation before any event — emit a synthetic malformed event (iso:"")
        // so the line is preserved. formatTimestamp("") returns "" safely (NaN guard in place).
        pushTaggedEvent({
          iso: "",
          ts: 0,
          text: line,
          _idx: i,
          malformed: true,
        })
      }
      continue
    }
    const iso = m[1]
    if (iso === undefined) continue
    const parsed = new Date(iso).getTime()
    if (Number.isNaN(parsed)) {
      // Regex-matched but unparseable timestamp (e.g. month 13): tag as malformed and sort
      // by file index rather than inheriting a neighbour's timestamp — avoids ambiguity.
      pushTaggedEvent({
        iso,
        ts: 0,
        text: line.slice(m[0].length),
        _idx: i,
        malformed: true,
      })
    } else {
      pushTaggedEvent({
        iso,
        ts: parsed,
        text: line.slice(m[0].length),
        _idx: i,
      })
    }
  }

  // Sort valid events by timestamp, breaking ties by file index
  validEvents.sort((a, b) => a.ts - b.ts || a._idx - b._idx)

  // Normalize every malformed record before sorting: guarantee string iso and finite numeric
  // _idx/_seq so the comparator never receives unexpected runtime types regardless of how
  // the record was constructed (two creation paths: leading continuation and NaN timestamp).
  for (const ev of malformedEvents) {
    if (typeof ev.iso !== "string") ev.iso = ""
    if (typeof ev._idx !== "number" || !Number.isFinite(ev._idx)) ev._idx = 0
    if (typeof ev._seq !== "number" || !Number.isFinite(ev._seq)) ev._seq = 0
  }

  // Three-key comparator — explicit multi-statement form; String() coercion on iso as a
  // second defence layer in case a future path bypasses the normalization above:
  //   1. _idx — file position (loop var i, structurally unique)
  //   2. iso  — lexicographic fallback; String() guards against non-string runtime values
  //   3. _seq — insertion order into malformed[] (unique within array, set at ev creation)
  malformedEvents.sort((a, b) => {
    const byIdx = (a._idx ?? 0) - (b._idx ?? 0)
    if (byIdx !== 0) return byIdx
    const byIso = String(a.iso ?? "").localeCompare(String(b.iso ?? ""))
    if (byIso !== 0) return byIso
    return (a._seq ?? 0) - (b._seq ?? 0)
  })

  // Two-pass merge: insert each malformed event immediately after the last valid event
  // whose _idx precedes it in the file. This places parse errors at their structural
  // position in the output rather than at an ambiguous inherited timestamp bucket.
  const result: Tagged[] = []
  let vi = 0
  for (const malformed of malformedEvents) {
    while (vi < validEvents.length && (validEvents[vi]?._idx ?? Infinity) < malformed._idx) {
      result.push(validEvents[vi]!)
      vi++
    }
    result.push(malformed)
  }
  while (vi < validEvents.length) {
    result.push(validEvents[vi]!)
    vi++
  }

  return result.map(({ iso, ts, text }) => ({ iso, ts, text }))
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

// ─── Main rendering ──────────────────────────────────────────────────────────

function renderTurns(turns: Turn[], sessionId: string, debugEvents?: DebugEvent[]): void {
  console.log(
    `\n${DIM}Session: ${sessionId}${RESET}\n${DIM}${"─".repeat(SESSION_RULE_WIDTH)}${RESET}`
  )

  // Build a sorted index of debug events for interleaving
  let debugIdx = 0
  const debug = debugEvents ?? []

  const flushDebugUpTo = (untilTs: number): void => {
    while (debugIdx < debug.length) {
      const ev = debug[debugIdx]
      if (!ev || ev.ts > untilTs) break
      renderDebugLine(ev)
      debugIdx++
    }
  }

  for (const { entry, role } of turns) {
    const turnTs = entry.timestamp ? new Date(entry.timestamp).getTime() : null

    // Flush any debug lines timestamped before this turn
    if (turnTs !== null) flushDebugUpTo(turnTs)

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

  // Flush remaining debug lines after the last turn
  while (debugIdx < debug.length) {
    const ev = debug[debugIdx]
    if (!ev) break
    renderDebugLine(ev)
    debugIdx++
  }

  if (turns.length === 0) {
    console.log(`\n  ${DIM}(no conversation turns found)${RESET}\n`)
  } else {
    console.log(`\n${DIM}${"─".repeat(SESSION_RULE_WIDTH)}${RESET}\n`)
  }
}

// ─── Auto-reply generation ────────────────────────────────────────────────────

async function generateAutoReply(turns: Turn[]): Promise<void> {
  // Build a plain-text representation of the conversation for LLM context
  const lines: string[] = []
  for (const { entry, role } of turns) {
    if (role === "user") {
      const text = extractText(entry.message?.content).trim()
      if (text) lines.push(`User: ${text}\n`)
    } else {
      const blocks = toContentBlocks(entry.message?.content)
      const textParts = blocks
        .filter((b): b is TextBlock => isVisibleTextBlock(b))
        .map((b) => b.text!.trim())
      if (textParts.length > 0) {
        lines.push(`Assistant: ${textParts.join("\n")}\n`)
      }
    }
  }

  const context = lines.join("\n").trim()
  const prompt =
    `Based on the conversation below, write a single natural follow-up message ` +
    `that the user might send to continue the conversation. ` +
    `Write ONLY the message itself — no prefix, no explanation, no metadata.\n\n` +
    `<conversation>\n${context}\n</conversation>`

  const output = await promptAgent(prompt)
  console.log(output)
}

// ─── Arg Parsing ─────────────────────────────────────────────────────────────

export interface TranscriptArgs {
  sessionQuery: string | null
  targetDir: string
  listOnly: boolean
  headCount: number | undefined
  tailCount: number | undefined
  autoReply: boolean
  includeDebug: boolean
  allAgents: boolean
  explicitAgents: AgentDef[]
}

export function parseTranscriptArgs(args: string[]): TranscriptArgs {
  let sessionQuery: string | null = null
  let targetDir: string = process.cwd()
  let listOnly = false
  let headCount: number | undefined
  let tailCount: number | undefined
  let autoReply = false
  let includeDebug = false
  let allAgents = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg) continue
    const next = args[i + 1]
    if ((arg === "--session" || arg === "-s") && next) {
      sessionQuery = next
      i++
    } else if ((arg === "--dir" || arg === "-d") && next) {
      targetDir = resolve(next)
      i++
    } else if (arg === "--list" || arg === "-l") {
      listOnly = true
    } else if ((arg === "--head" || arg === "-H") && next) {
      headCount = parseInt(next, 10)
      i++
    } else if ((arg === "--tail" || arg === "-T") && next) {
      tailCount = parseInt(next, 10)
      i++
    } else if (arg === "--auto-reply") {
      autoReply = true
    } else if (arg === "--include-debug") {
      includeDebug = true
    } else if (arg === "--all") {
      allAgents = true
    }
  }

  const explicitAgents = AGENTS.filter((agent) => args.includes(`--${agent.id}`))
  return {
    sessionQuery,
    targetDir,
    listOnly,
    headCount,
    tailCount,
    autoReply,
    includeDebug,
    allAgents,
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
    const date = new Date(session.mtime)
    const label = date.toLocaleString([], {
      dateStyle: "short",
      timeStyle: "short",
    })
    console.log(`  ${session.id}  ${DIM}${label}${RESET}`)
  }
  console.log()
}

// ─── Command ─────────────────────────────────────────────────────────────────

export const transcriptCommand: Command = {
  name: "transcript",
  description: "Display Agent-User chat history for the current project",
  usage:
    "swiz transcript [--session <id>] [--dir <path>] [--list] [--head N] [--tail N] [--auto-reply] [--include-debug] [--all|--claude|--cursor|--gemini|--codex]",
  options: [
    { flags: "--session, -s <id>", description: "Show a specific session (prefix match)" },
    { flags: "--dir, -d <path>", description: "Target project directory (default: cwd)" },
    { flags: "--list, -l", description: "List available sessions without displaying content" },
    { flags: "--head, -H <n>", description: "Show only the first N conversation turns" },
    { flags: "--tail, -T <n>", description: "Show only the last N conversation turns" },
    { flags: "--auto-reply", description: "Generate an AI-suggested follow-up message" },
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
  async run(args) {
    const {
      sessionQuery,
      targetDir,
      listOnly,
      headCount,
      tailCount,
      autoReply,
      includeDebug,
      allAgents,
      explicitAgents,
    } = parseTranscriptArgs(args)

    if (allAgents && explicitAgents.length > 0) {
      throw new Error("`--all` cannot be combined with an explicit agent flag.")
    }
    if (explicitAgents.length > 1) {
      throw new Error("Specify at most one agent: --claude, --cursor, --gemini, or --codex.")
    }

    const detectedAgent = detectCurrentAgent()
    const selectedAgents = resolveSelectedAgents(allAgents, explicitAgents, detectedAgent)
    const selectedProviders = getSelectedProviders(selectedAgents)

    if (selectedProviders.size === 0) {
      const agentLabel = selectedAgents[0]?.name ?? "selected agent"
      throw new Error(
        `${agentLabel} transcript discovery is not supported yet.\nUse --all or --claude/--gemini/--codex.`
      )
    }

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

    if (listOnly) {
      renderSessionList(sessions, targetDir)
      return
    }

    const session = pickSession(sessions, sessionQuery)

    let turns = await loadTurns(session)
    turns = applyHeadTail(turns, headCount, tailCount)

    let debugEvents: DebugEvent[] | undefined
    if (includeDebug) {
      const debugFile = await loadDebugLog(session.id)
      if (!debugFile) {
        console.log(`\n${DIM}Debug log not found for session: ${session.id}${RESET}`)
      } else {
        debugEvents = applyHeadTail(parseDebugEvents(debugFile.lines), headCount, tailCount)
      }
    }

    if (autoReply) {
      await generateAutoReply(turns)
    } else {
      renderTurns(turns, session.id, debugEvents)
    }
  },
}
