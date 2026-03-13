import { resolve } from "node:path"
import { detectAgentCli, promptAgent } from "../agent.ts"
import { type AiProviderId, hasAiProvider, promptText } from "../ai-providers.ts"
import { DIM, RESET } from "../ansi.ts"
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
    if (!next) throw new Error(`Missing value for ${arg}`)
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

function buildResumeArgs(
  session: Session,
  sessionQuery: string | null,
  suggestion: string
): string[] {
  const canResumeClaudeSession = session.provider === "claude"
  const shouldResumeById = Boolean(sessionQuery) && canResumeClaudeSession
  const resumeArgs: string[] = shouldResumeById
    ? ["claude", "--resume", session.id, suggestion]
    : ["claude", "--continue", suggestion]

  if (sessionQuery && !canResumeClaudeSession) {
    console.log(
      `${DIM}Session ${session.id} is from ${session.provider ?? "another provider"}; using --continue instead of --resume.${RESET}`
    )
  }
  return resumeArgs
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

    const resumeArgs = buildResumeArgs(session, sessionQuery, suggestion)
    const proc = Bun.spawn(resumeArgs, {
      stdout: "inherit",
      stderr: "inherit",
      stdin: "inherit",
    })
    await proc.exited
    process.exitCode = proc.exitCode ?? 0
  },
}
