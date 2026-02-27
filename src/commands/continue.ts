import { join, resolve } from "node:path"
import { detectAgentCli, promptAgent } from "../agent.ts"
import {
  extractPlainTurns,
  findSessions,
  formatTurnsAsContext,
  projectKeyFromCwd,
  type Session,
} from "../transcript-utils.ts"
import type { Command } from "../types.ts"

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
      targetDir = resolve(next); i++
    } else if ((arg === "--session" || arg === "-s") && next) {
      sessionQuery = next; i++
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
    const HOME = process.env.HOME ?? "~"
    const PROJECTS_DIR = join(HOME, ".claude", "projects")

    const { targetDir, sessionQuery, printOnly } = parseContinueArgs(args)

    if (!detectAgentCli()) {
      throw new Error(
        "No AI backend found. Install one of: Cursor Agent (agent), Claude Code (claude), or Gemini CLI (gemini)."
      )
    }

    const projectKey = projectKeyFromCwd(targetDir)
    const projectDir = join(PROJECTS_DIR, projectKey)
    const sessions = await findSessions(projectDir)

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
      session = sessions[0]!
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

    // Resume the session with the suggestion as the first user message.
    // --session flag maps to --resume <id>; default uses --continue (most recent).
    const resumeArgs: string[] = sessionQuery
      ? ["claude", "--resume", session.id, suggestion]
      : ["claude", "--continue", suggestion]

    const proc = Bun.spawn(resumeArgs, {
      stdout: "inherit",
      stderr: "inherit",
      stdin: "inherit",
    })
    await proc.exited
    process.exitCode = proc.exitCode ?? 0
  },
}
