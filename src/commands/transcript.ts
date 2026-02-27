import { readdir, stat } from "node:fs/promises"
import { join, resolve } from "node:path"
import { promptAgent } from "../agent.ts"
import type { Command } from "../types.ts"

// ─── Types ───────────────────────────────────────────────────────────────────

interface TextBlock {
  type: "text"
  text?: string
}

interface ToolUseBlock {
  type: "tool_use"
  id?: string
  name?: string
  input?: Record<string, unknown>
}

type ContentBlock = TextBlock | ToolUseBlock | { type: string; [key: string]: unknown }

interface TranscriptEntry {
  type: string
  sessionId?: string
  timestamp?: string
  cwd?: string
  message?: {
    role?: string
    content?: string | ContentBlock[]
  }
}

interface Session {
  id: string
  path: string
  mtime: number
}

// ─── Project key ─────────────────────────────────────────────────────────────

function projectKeyFromCwd(cwd: string): string {
  return cwd.replace(/[/.]/g, "-")
}

// ─── Session discovery ───────────────────────────────────────────────────────

async function findSessions(projectDir: string): Promise<Session[]> {
  let entries: string[]
  try {
    entries = await readdir(projectDir)
  } catch {
    return []
  }

  const sessions: Session[] = []
  for (const entry of entries) {
    if (!entry.endsWith(".jsonl")) continue
    const id = entry.slice(0, -6) // strip .jsonl
    const filePath = join(projectDir, entry)
    try {
      const s = await stat(filePath)
      sessions.push({ id, path: filePath, mtime: s.mtimeMs })
    } catch {}
  }

  return sessions.sort((a, b) => b.mtime - a.mtime) // newest first
}

// ─── Text extraction ─────────────────────────────────────────────────────────

function extractText(content: string | ContentBlock[] | undefined): string {
  if (!content) return ""
  if (typeof content === "string") return content
  return content
    .filter((b): b is TextBlock => b.type === "text" && !!(b as TextBlock).text)
    .map((b) => b.text!)
    .join("\n")
    .trim()
}

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

function formatToolUse(name: string, input: Record<string, unknown>): string {
  // Task tool: use subagent_type as name, description as param
  if (name === "Task" && input.subagent_type) {
    const desc = typeof input.description === "string" ? input.description.slice(0, 70) : ""
    return `${input.subagent_type}(${desc})`
  }
  const param = TOOL_KEY_PARAM[name]
  if (param && input[param] !== undefined) {
    return `${name}(${String(input[param]).slice(0, 70)})`
  }
  // Fallback: first string value in input
  const firstStr = Object.values(input).find((v) => typeof v === "string")
  if (firstStr) return `${name}(${String(firstStr).slice(0, 70)})`
  return name
}

// ─── ANSI helpers ────────────────────────────────────────────────────────────

const BOLD = "\x1b[1m"
const DIM = "\x1b[2m"
const CYAN = "\x1b[36m"
const YELLOW = "\x1b[33m"
const GREEN = "\x1b[32m"
const RESET = "\x1b[0m"

// ─── Rendering ───────────────────────────────────────────────────────────────

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
        current += " " + word
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

  const cols = process.stdout.columns ?? 80
  const wrapWidth = Math.min(cols - 4, 100)
  const wrapped = wordWrap(text.trim(), wrapWidth, "  ")
  console.log(wrapped)
}

function renderAssistantBlocks(entry: TranscriptEntry): boolean {
  const content = entry.message?.content
  if (!content) return false

  const blocks: ContentBlock[] =
    typeof content === "string" ? [{ type: "text", text: content }] : content

  const visible = blocks.filter(
    (b) =>
      (b.type === "text" && !!(b as TextBlock).text?.trim()) ||
      (b.type === "tool_use" && !!(b as ToolUseBlock).name)
  )
  if (visible.length === 0) return false

  const ts = entry.timestamp ? ` ${DIM}${formatTimestamp(entry.timestamp)}${RESET}` : ""
  console.log(`\n${CYAN}${BOLD}ASSISTANT${RESET}${ts}`)

  const cols = process.stdout.columns ?? 80
  const wrapWidth = Math.min(cols - 4, 100)

  for (const block of blocks) {
    if (block.type === "text") {
      const text = (block as TextBlock).text?.trim()
      if (text) console.log(wordWrap(text, wrapWidth, "  "))
    } else if (block.type === "tool_use") {
      const b = block as ToolUseBlock
      if (b.name) {
        const label = formatToolUse(b.name, b.input ?? {})
        console.log(`  ${GREEN}⏺${RESET} ${DIM}${label}${RESET}`)
      }
    }
  }

  return true
}

// ─── Turn collection ─────────────────────────────────────────────────────────

interface Turn {
  entry: TranscriptEntry
  role: "user" | "assistant"
}

function collectTurns(lines: string[]): Turn[] {
  const turns: Turn[] = []
  for (const line of lines) {
    let entry: TranscriptEntry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }

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
      const content = entry.message?.content
      const blocks: ContentBlock[] =
        typeof content === "string" ? [{ type: "text", text: content }] : (content ?? [])
      const hasVisible = blocks.some(
        (b) =>
          (b.type === "text" && !!(b as TextBlock).text?.trim()) ||
          (b.type === "tool_use" && !!(b as ToolUseBlock).name)
      )
      if (!hasVisible) continue
    } else {
      if (!extractText(msg.content).trim()) continue
    }

    turns.push({ entry, role: entry.type as "user" | "assistant" })
  }
  return turns
}

// ─── Turn loading ─────────────────────────────────────────────────────────────

async function loadTurns(sessionPath: string): Promise<Turn[]> {
  const file = Bun.file(sessionPath)
  if (!(await file.exists())) {
    throw new Error(`Transcript not found: ${sessionPath}`)
  }
  const text = await file.text()
  return collectTurns(text.split("\n").filter(Boolean))
}

// ─── Main rendering ──────────────────────────────────────────────────────────

function renderTurns(turns: Turn[], sessionId: string): void {
  console.log(`\n${DIM}Session: ${sessionId}${RESET}\n${DIM}${"─".repeat(60)}${RESET}`)

  for (const { entry, role } of turns) {
    if (role === "assistant") {
      renderAssistantBlocks(entry)
    } else {
      renderTurn("user", extractText(entry.message?.content), entry.timestamp)
    }
  }

  if (turns.length === 0) {
    console.log(`\n  ${DIM}(no conversation turns found)${RESET}\n`)
  } else {
    console.log(`\n${DIM}${"─".repeat(60)}${RESET}\n`)
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
      const content = entry.message?.content
      const blocks: ContentBlock[] =
        typeof content === "string" ? [{ type: "text", text: content }] : (content ?? [])
      const textParts = blocks
        .filter((b): b is TextBlock => b.type === "text" && !!(b as TextBlock).text?.trim())
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
}

export function parseTranscriptArgs(args: string[]): TranscriptArgs {
  let sessionQuery: string | null = null
  let targetDir: string = process.cwd()
  let listOnly = false
  let headCount: number | undefined
  let tailCount: number | undefined
  let autoReply = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg) continue
    const next = args[i + 1]
    if ((arg === "--session" || arg === "-s") && next) {
      sessionQuery = next; i++
    } else if ((arg === "--dir" || arg === "-d") && next) {
      targetDir = resolve(next); i++
    } else if (arg === "--list" || arg === "-l") {
      listOnly = true
    } else if ((arg === "--head" || arg === "-H") && next) {
      headCount = parseInt(next, 10); i++
    } else if ((arg === "--tail" || arg === "-T") && next) {
      tailCount = parseInt(next, 10); i++
    } else if (arg === "--auto-reply") {
      autoReply = true
    }
  }

  return { sessionQuery, targetDir, listOnly, headCount, tailCount, autoReply }
}

// ─── Command ─────────────────────────────────────────────────────────────────

export const transcriptCommand: Command = {
  name: "transcript",
  description: "Display Agent-User chat history for the current project",
  usage:
    "swiz transcript [--session <id>] [--dir <path>] [--list] [--head N] [--tail N] [--auto-reply]",
  options: [
    { flags: "--session, -s <id>", description: "Show a specific session (prefix match)" },
    { flags: "--dir, -d <path>", description: "Target project directory (default: cwd)" },
    { flags: "--list, -l", description: "List available sessions without displaying content" },
    { flags: "--head, -H <n>", description: "Show only the first N conversation turns" },
    { flags: "--tail, -T <n>", description: "Show only the last N conversation turns" },
    { flags: "--auto-reply", description: "Generate an AI-suggested follow-up message" },
  ],
  async run(args) {
    const HOME = process.env.HOME ?? "~"
    const PROJECTS_DIR = join(HOME, ".claude", "projects")

    const { sessionQuery, targetDir, listOnly, headCount, tailCount, autoReply } =
      parseTranscriptArgs(args)

    const projectKey = projectKeyFromCwd(targetDir)
    const projectDir = join(PROJECTS_DIR, projectKey)

    const sessions = await findSessions(projectDir)

    if (sessions.length === 0) {
      throw new Error(`No transcripts found for: ${targetDir}\n(looked in: ${projectDir})`)
    }

    if (listOnly) {
      console.log(`\n  Transcripts for ${targetDir}\n`)
      for (const s of sessions) {
        const d = new Date(s.mtime)
        const label = d.toLocaleString([], {
          dateStyle: "short",
          timeStyle: "short",
        })
        console.log(`  ${s.id}  ${DIM}${label}${RESET}`)
      }
      console.log()
      return
    }

    // Find the target session
    let session: Session
    if (sessionQuery) {
      const match = sessions.find((s) => s.id.startsWith(sessionQuery!))
      if (!match) {
        const available = sessions.map((s) => `  ${s.id}`).join("\n")
        throw new Error(`No session matching: ${sessionQuery}\nAvailable sessions:\n${available}`)
      }
      session = match
    } else {
      session = sessions[0]! // newest session
    }

    let turns = await loadTurns(session.path)
    if (tailCount !== undefined) {
      turns = turns.slice(-tailCount)
    } else if (headCount !== undefined) {
      turns = turns.slice(0, headCount)
    }

    if (autoReply) {
      await generateAutoReply(turns)
    } else {
      renderTurns(turns, session.id)
    }
  },
}
