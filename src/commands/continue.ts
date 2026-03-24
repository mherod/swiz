import { resolve } from "node:path"
import type { CanUseTool, SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { detectAgentCli, promptAgent } from "../agent.ts"
import { type AiProviderId, hasAiProvider, promptText } from "../ai-providers.ts"
import { CYAN, DIM, GREEN, RED, RESET, YELLOW } from "../ansi.ts"
import { stderrLog } from "../debug.ts"
import {
  extractPlainTurns,
  findAllProviderSessions,
  findHumanRequiredBlock,
  formatTurnsAsContext,
  getUnsupportedTranscriptFormatMessage,
  isUnsupportedTranscriptFormat,
  type Session,
} from "../transcript-utils.ts"
import type { Command } from "../types.ts"

// ─── Next-step suggestion ─────────────────────────────────────────────────────

async function generateNextStep(jsonlText: string, provider?: AiProviderId): Promise<string> {
  const turns = extractPlainTurns(jsonlText).slice(-20)
  const context = formatTurnsAsContext(turns)

  const prompt =
    `You are analyzing a conversation between a user and an AI assistant. ` +
    `Based on the conversation below, suggest a single concrete next step the ` +
    `assistant should take. Be specific and actionable. ` +
    `Reply with ONLY one sentence starting with an imperative verb ` +
    `(Run, Fix, Add, Check, Verify, Commit, etc.) — ` +
    `no explanation, no markdown, no prefix, no period at the end.\n\n` +
    `<conversation>\n${context}\n</conversation>`

  // Prefer explicit provider override or ai-providers layer (Gemini/Codex).
  // Fall back to Cursor Agent CLI when no AI SDK provider is configured.
  if (provider || hasAiProvider()) {
    return promptText(prompt, { provider })
  }
  return promptAgent(prompt)
}

// ─── Arg Parsing ─────────────────────────────────────────────────────────────

export interface ContinueArgs {
  targetDir: string
  sessionQuery: string | null
  printOnly: boolean
  provider?: AiProviderId
}

const VALID_PROVIDERS = new Set(["gemini", "claude", "openrouter"])

function validateProvider(value: string): AiProviderId {
  if (!VALID_PROVIDERS.has(value)) {
    throw new Error(`--provider must be "gemini", "claude", or "openrouter", got: ${value}`)
  }
  return value as AiProviderId
}

const CONTINUE_VALUE_FLAGS: Record<string, "dir" | "session" | "provider"> = {
  "--dir": "dir",
  "-d": "dir",
  "--session": "session",
  "-s": "session",
  "--provider": "provider",
  "-p": "provider",
}

export function parseContinueArgs(args: string[]): ContinueArgs {
  let targetDir = process.cwd()
  let sessionQuery: string | null = null
  let printOnly = false
  let provider: AiProviderId | undefined

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg) continue
    if (arg === "--print") {
      printOnly = true
      continue
    }
    const field = CONTINUE_VALUE_FLAGS[arg]
    if (!field) continue
    const next = args[i + 1]
    if (!next) {
      if (field === "provider") throw new Error(`Missing value for ${arg}`)
      continue
    }
    i++
    if (field === "dir") targetDir = resolve(next)
    else if (field === "session") sessionQuery = next
    else provider = validateProvider(next)
  }

  return { targetDir, sessionQuery, printOnly, provider }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function resolveSession(targetDir: string, sessionQuery: string | null): Promise<Session> {
  const sessions = await findAllProviderSessions(targetDir)
  if (sessions.length === 0) {
    throw new Error(`No transcripts found for: ${targetDir}`)
  }

  let session: Session
  if (sessionQuery) {
    const match = sessions.find((s) => s.id.startsWith(sessionQuery))
    if (!match) throw new Error(`No session matching: ${sessionQuery}`)
    session = match
  } else {
    session = sessions.find((s) => !isUnsupportedTranscriptFormat(s.format)) ?? sessions[0]!
  }

  if (isUnsupportedTranscriptFormat(session.format)) {
    throw new Error(getUnsupportedTranscriptFormatMessage(session))
  }
  return session
}

function ensureAiBackend(): void {
  if (!hasAiProvider() && !detectAgentCli()) {
    throw new Error(
      "No AI backend found. Set GEMINI_API_KEY, OPENROUTER_API_KEY, install the claude CLI, or install Cursor Agent."
    )
  }
}

async function readTranscriptText(session: Session): Promise<string> {
  try {
    return await Bun.file(session.path).text()
  } catch {
    throw new Error(`Could not read transcript: ${session.path}`)
  }
}

async function generateSuggestion(raw: string, provider?: AiProviderId): Promise<string> {
  let suggestion: string
  try {
    suggestion = await generateNextStep(raw, provider)
  } catch (err) {
    throw new Error(`Failed to generate suggestion: ${String(err)}`)
  }
  if (!suggestion) throw new Error("Empty suggestion returned from AI backend.")
  return suggestion
}

function resolveQueryOptions(
  session: Session,
  sessionQuery: string | null,
  targetDir: string
): { resume?: string; continue?: boolean; cwd: string } {
  const canResumeClaudeSession = session.provider === "claude"
  const shouldResumeById = Boolean(sessionQuery) && canResumeClaudeSession

  if (sessionQuery && !canResumeClaudeSession) {
    console.log(
      `${DIM}Session ${session.id} is from ${session.provider ?? "another provider"}; using --continue instead of --resume.${RESET}`
    )
  }

  if (shouldResumeById) {
    return { resume: session.id, cwd: targetDir }
  }
  return { continue: true, cwd: targetDir }
}

function log(msg: string): void {
  stderrLog("SDK agent message stream logging", `${DIM}[continue]${RESET} ${msg}`)
}

// ─── Permission auto-approval ────────────────────────────────────────────────

const autoApprove: CanUseTool = async (toolName, input, _options) => {
  const summary = formatToolInput(toolName, input)
  log(`${GREEN}allow${RESET} ${CYAN}${toolName}${RESET}${summary}`)
  return { behavior: "allow", updatedInput: input }
}

function formatToolInput(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case "Bash": {
      const cmd = input.command as string | undefined
      return cmd ? ` ${DIM}$ ${cmd}${RESET}` : ""
    }
    case "Edit":
    case "Write":
    case "Read": {
      const path = input.file_path as string | undefined
      return path ? ` ${DIM}${path}${RESET}` : ""
    }
    case "Glob": {
      const pattern = input.pattern as string | undefined
      return pattern ? ` ${DIM}${pattern}${RESET}` : ""
    }
    case "Grep": {
      const pattern = input.pattern as string | undefined
      return pattern ? ` ${DIM}/${pattern}/${RESET}` : ""
    }
    default:
      return ""
  }
}

// ─── Progress spinner ────────────────────────────────────────────────────────

const SPINNER_FRAMES = [
  "\u28CB",
  "\u28D9",
  "\u28F9",
  "\u28F8",
  "\u28FC",
  "\u28F4",
  "\u28E6",
  "\u28E7",
  "\u28C7",
  "\u28CF",
]

function createSpinner(label: string): { stop(): void } {
  let frame = 0
  const start = Date.now()
  const timer = setInterval(() => {
    const elapsed = ((Date.now() - start) / 1000).toFixed(0)
    process.stderr.write(
      `\r${DIM}${SPINNER_FRAMES[frame % SPINNER_FRAMES.length]} ${label} ${elapsed}s${RESET}`
    )
    frame++
  }, 80)

  return {
    stop() {
      clearInterval(timer)
      process.stderr.write("\r\x1b[2K")
    },
  }
}

// ─── Stateless message sub-handlers ──────────────────────────────────────────

function handleAssistantMessage(message: unknown): void {
  const msg = message as {
    message: { content: Array<{ type: string; name?: string; id?: string }> }
    error?: string
  }
  for (const block of msg.message.content) {
    if (block.type === "tool_use") {
      log(`${CYAN}tool_use${RESET} ${block.name} ${DIM}(id: ${block.id})${RESET}`)
    }
  }
  if (msg.error) {
    log(`${RED}assistant error:${RESET} ${msg.error}`)
  }
}

function handleToolProgress(message: unknown): void {
  const msg = message as { tool_name: string; elapsed_time_seconds: number }
  log(
    `${DIM}tool_progress${RESET} ${msg.tool_name} ${DIM}elapsed=${msg.elapsed_time_seconds}s${RESET}`
  )
}

function handleToolSummary(message: unknown): void {
  const msg = message as { summary: string }
  log(`${DIM}tool_summary${RESET} ${msg.summary}`)
}

function handleSystemMessage(message: unknown): void {
  const msg = message as {
    subtype: string
    status?: string
    compact_metadata?: { trigger: string }
  }
  if (msg.subtype === "status") {
    log(`${DIM}status: ${msg.status}${RESET}`)
  } else if (msg.subtype === "compact_boundary") {
    log(`${YELLOW}compaction${RESET} ${DIM}trigger=${msg.compact_metadata?.trigger}${RESET}`)
  }
}

// ─── Message handler ─────────────────────────────────────────────────────────

function createMessageHandler(): (message: SDKMessage) => void {
  let firstOutputReceived = false
  const spinner = createSpinner("Waiting for response\u2026")

  function clearSpinner(): void {
    if (!firstOutputReceived) {
      spinner.stop()
      firstOutputReceived = true
    }
  }

  function handleResultMessage(message: SDKMessage & { type: "result" }): void {
    clearSpinner()
    process.stdout.write("\n")
    const duration = (message.duration_ms / 1000).toFixed(1)
    const apiDuration = (message.duration_api_ms / 1000).toFixed(1)
    const cost = message.total_cost_usd.toFixed(4)
    if (message.subtype === "success") {
      log(
        `${GREEN}result: success${RESET} ${DIM}turns=${message.num_turns} duration=${duration}s api=${apiDuration}s cost=$${cost}${RESET}`
      )
    } else {
      log(
        `${RED}result: ${message.subtype}${RESET} ${DIM}turns=${message.num_turns} duration=${duration}s api=${apiDuration}s cost=$${cost}${RESET}`
      )
      if ("errors" in message && message.errors.length > 0) {
        for (const err of message.errors) {
          log(`${RED}  error: ${err}${RESET}`)
        }
      }
      process.exitCode = 1
    }
    if (message.permission_denials.length > 0) {
      log(`${YELLOW}permission denials: ${message.permission_denials.length}${RESET}`)
      for (const d of message.permission_denials) {
        log(`${DIM}  denied: ${d.tool_name} (${d.tool_use_id})${RESET}`)
      }
    }
  }

  function handleStreamEvent(message: unknown): void {
    const msg = message as { event: unknown }
    const event = msg.event as {
      type: string
      delta?: { type: string; text?: string }
      content_block?: { type: string; name?: string; id?: string }
    }
    if (event.type === "content_block_delta") {
      if (event.delta?.type === "text_delta") {
        clearSpinner()
        process.stdout.write(event.delta.text || "")
      }
    } else if (event.type === "content_block_start") {
      if (event.content_block?.type === "tool_use") {
        clearSpinner()
        log(
          `${CYAN}tool_use${RESET} ${event.content_block.name} ${DIM}(id: ${event.content_block.id})${RESET}`
        )
      }
    }
  }

  return (message: SDKMessage) => {
    switch (message.type) {
      case "stream_event":
        handleStreamEvent(message)
        break
      case "assistant":
        handleAssistantMessage(message)
        break
      case "result":
        handleResultMessage(message as SDKMessage & { type: "result" })
        break
      case "tool_progress":
        handleToolProgress(message)
        break
      case "tool_use_summary":
        handleToolSummary(message)
        break
      case "system":
        handleSystemMessage(message)
        break
    }
  }
}

// ─── Command ──────────────────────────────────────────────────────────────────

export const continueCommand: Command = {
  name: "continue",
  description: "Resume the most recent session with an AI-generated next step",
  usage: "swiz continue [--dir <path>] [--session <id>] [--print]",
  options: [
    { flags: "--dir, -d <path>", description: "Target project directory (default: cwd)" },
    { flags: "--session, -s <id>", description: "Resume a specific session (prefix match)" },
    { flags: "--print", description: "Print the suggested next step without resuming" },
    {
      flags: "--provider, -p <name>",
      description:
        'AI provider override: "gemini", "claude", or "openrouter" (default: auto-select)',
    },
  ],
  async run(args) {
    const { targetDir, sessionQuery, printOnly, provider } = parseContinueArgs(args)
    const session = await resolveSession(targetDir, sessionQuery)
    ensureAiBackend()

    const raw = await readTranscriptText(session)
    const humanRequiredReason = findHumanRequiredBlock(raw)
    if (humanRequiredReason) {
      console.log(humanRequiredReason)
      return
    }

    const suggestion = await generateSuggestion(raw, provider)
    if (printOnly) {
      console.log(suggestion)
      return
    }

    const { query } = await import("@anthropic-ai/claude-agent-sdk")
    const queryOptions = resolveQueryOptions(session, sessionQuery, targetDir)

    log(`${DIM}session: ${session.id} (${session.provider ?? "unknown"})${RESET}`)
    log(`${DIM}prompt: ${suggestion}${RESET}`)
    if (queryOptions.resume) {
      log(`${DIM}mode: resume (id=${queryOptions.resume})${RESET}`)
    } else {
      log(`${DIM}mode: continue${RESET}`)
    }

    const conversation = query({
      prompt: suggestion,
      options: {
        ...queryOptions,
        tools: { type: "preset", preset: "claude_code" },
        systemPrompt: { type: "preset", preset: "claude_code" },
        settingSources: ["user", "project", "local"],
        includePartialMessages: true,
        canUseTool: autoApprove,
      },
    })

    const handleMessage = createMessageHandler()
    for await (const message of conversation) {
      handleMessage(message)
    }
  },
}
