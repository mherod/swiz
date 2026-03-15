import { resolve } from "node:path"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
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

const VALID_PROVIDERS = new Set(["gemini", "codex", "claude"])

function validateProvider(value: string): AiProviderId {
  if (!VALID_PROVIDERS.has(value)) {
    throw new Error(`--provider must be "gemini", "codex", or "claude", got: ${value}`)
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
      "No AI backend found. Set GEMINI_API_KEY, install the codex CLI, or install Cursor Agent."
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

function writeMessageText(message: SDKMessage): void {
  switch (message.type) {
    case "assistant": {
      for (const block of message.message.content) {
        if (block.type === "text") {
          process.stdout.write(block.text)
        } else if (block.type === "tool_use") {
          log(`${CYAN}tool_use${RESET} ${block.name} ${DIM}(id: ${block.id})${RESET}`)
        }
      }
      process.stdout.write("\n")
      if (message.error) {
        log(`${RED}assistant error:${RESET} ${message.error}`)
      }
      break
    }
    case "result": {
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
      break
    }
    case "tool_progress": {
      log(
        `${DIM}tool_progress${RESET} ${message.tool_name} ${DIM}elapsed=${message.elapsed_time_seconds}s${RESET}`
      )
      break
    }
    case "tool_use_summary": {
      log(`${DIM}tool_summary${RESET} ${message.summary}`)
      break
    }
    case "system": {
      if (message.subtype === "status") {
        log(`${DIM}status: ${message.status}${RESET}`)
      } else if (message.subtype === "compact_boundary") {
        log(`${YELLOW}compaction${RESET} ${DIM}trigger=${message.compact_metadata.trigger}${RESET}`)
      }
      break
    }
    case "stream_event": {
      // Partial streaming — no logging needed
      break
    }
    default:
      break
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
      description: 'AI provider override: "gemini", "codex", or "claude" (default: auto-select)',
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
      },
    })

    for await (const message of conversation) {
      writeMessageText(message)
    }
  },
}
