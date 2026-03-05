import { resolve } from "node:path"
import { detectAgentCli, promptAgent } from "../agent.ts"
import {
  extractPlainTurns,
  findAllProviderSessions,
  formatTurnsAsContext,
  getUnsupportedTranscriptFormatMessage,
  isUnsupportedTranscriptFormat,
  type Session,
} from "../transcript-utils.ts"
import type { Command } from "../types.ts"

const DIM = "\x1b[2m"
const RESET = "\x1b[0m"

// ─── Next-step suggestion ─────────────────────────────────────────────────────

async function generateNextStep(jsonlText: string): Promise<string> {
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

  return promptAgent(prompt)
}

// ─── Arg Parsing ─────────────────────────────────────────────────────────────

export interface ContinueArgs {
  targetDir: string
  sessionQuery: string | null
  printOnly: boolean
}

export function parseContinueArgs(args: string[]): ContinueArgs {
  let targetDir = process.cwd()
  let sessionQuery: string | null = null
  let printOnly = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg) continue
    const next = args[i + 1]
    if ((arg === "--dir" || arg === "-d") && next) {
      targetDir = resolve(next)
      i++
    } else if ((arg === "--session" || arg === "-s") && next) {
      sessionQuery = next
      i++
    } else if (arg === "--print") {
      printOnly = true
    }
  }

  return { targetDir, sessionQuery, printOnly }
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
  ],
  async run(args) {
    const { targetDir, sessionQuery, printOnly } = parseContinueArgs(args)

    const sessions = await findAllProviderSessions(targetDir)

    if (sessions.length === 0) {
      throw new Error(`No transcripts found for: ${targetDir}`)
    }

    let session: Session
    if (sessionQuery) {
      const match = sessions.find((s) => s.id.startsWith(sessionQuery!))
      if (!match) {
        throw new Error(`No session matching: ${sessionQuery}`)
      }
      session = match
    } else {
      session = sessions.find((s) => !isUnsupportedTranscriptFormat(s.format)) ?? sessions[0]!
    }

    if (isUnsupportedTranscriptFormat(session.format)) {
      throw new Error(getUnsupportedTranscriptFormatMessage(session))
    }

    if (!detectAgentCli()) {
      throw new Error(
        "No AI backend found. Install one of: Cursor Agent (agent), Claude Code (claude), or Gemini CLI (gemini)."
      )
    }

    let raw: string
    try {
      raw = await Bun.file(session.path).text()
    } catch {
      throw new Error(`Could not read transcript: ${session.path}`)
    }

    let suggestion: string
    try {
      suggestion = await generateNextStep(raw)
    } catch (err) {
      throw new Error(`Failed to generate suggestion: ${String(err)}`)
    }

    if (!suggestion) {
      throw new Error("Empty suggestion returned from AI backend.")
    }

    if (printOnly) {
      console.log(suggestion)
      return
    }

    // Claude session IDs can be resumed directly. For non-Claude providers,
    // continue with a new Claude session using the generated suggestion.
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

    const proc = Bun.spawn(resumeArgs, {
      stdout: "inherit",
      stderr: "inherit",
      stdin: "inherit",
    })
    await proc.exited
    process.exitCode = proc.exitCode ?? 0
  },
}
