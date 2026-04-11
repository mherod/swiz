import { createOpenRouter } from "@openrouter/ai-sdk-provider"
import { type ModelMessage, stepCountIs, streamText } from "ai"
import { format } from "date-fns"
import { monitor } from "../../scripts/transcript/monitor-state.ts"
import { DIM, RESET } from "../ansi.ts"
import { detectCurrentAgent } from "../detect.ts"
import { grepTool, readTool } from "../tools.ts"
import {
  buildTimeRange,
  filterSessionsByTime,
  getSelectedProviders,
  loadFilteredSessions,
  parseTranscriptArgs,
  pickSession,
  resolveSelectedAgents,
  validateProviders,
  validateTranscriptArgs,
} from "../transcript-args.ts"
import type { DebugEvent } from "../transcript-debug.ts"
import { isVisibleTextBlock, toContentBlocks } from "../transcript-format.ts"
import { loadSessionContent, type Turn, turnsToDisplayTurns } from "../transcript-turns.ts"
import type { Session } from "../transcript-utils.ts"
import { extractText } from "../transcript-utils.ts"
import type { Command } from "../types.ts"
import { scheduleAutoSteer } from "../utils/auto-steer-helpers.ts"
import { messageFromUnknownError } from "../utils/hook-json-helpers.ts"

// ─── Monitor-based mode runners ──────────────────────────────────────────────

async function runListMode(sessions: Session[], targetDir: string): Promise<void> {
  const sessionItems = sessions.map((s) => ({
    id: s.id,
    label: format(new Date(s.mtime), "Pp"),
  }))
  monitor.updateStats({ mode: "list", sessions: sessionItems, targetDir })
  await monitor.start()
  try {
    monitor.setPhase("complete")
  } finally {
    monitor.stop()
  }
}

async function runDisplayMode(
  turns: Turn[],
  sessionId: string,
  debugEvents?: DebugEvent[]
): Promise<void> {
  const { displayTurns, trailingDebug } = turnsToDisplayTurns(turns, debugEvents)
  monitor.updateStats({
    mode: "display",
    sessionId,
    turns: displayTurns,
    totalTurns: displayTurns.length,
    trailingDebug,
  })
  await monitor.start()
  try {
    monitor.setPhase("complete")
  } finally {
    monitor.stop()
  }
}

async function runAutoReplyMode(
  turns: Turn[],
  sessionId: string,
  debugEvents?: DebugEvent[]
): Promise<void> {
  const { displayTurns, trailingDebug } = turnsToDisplayTurns(turns, debugEvents)
  monitor.updateStats({
    mode: "auto-reply",
    sessionId,
    turns: displayTurns,
    totalTurns: displayTurns.length,
    trailingDebug,
    contextTurns: turns.length,
  })
  await monitor.start()
  try {
    const allReplies: Turn[] = []
    const cwd = process.cwd()
    let passNumber = 0

    while (true) {
      passNumber++
      const flipRoles = passNumber % 2 === 0
      monitor.setPhase(`streaming-pass-${passNumber}`)
      const allTurns = turns.concat(allReplies)
      monitor.pushEvent(
        `Starting pass ${passNumber}${flipRoles ? " (flipped roles)" : " (original roles)"}`
      )
      const replies = await streamAutoReply(allTurns, {
        sessionId,
        flipRoles,
        cwd,
        passNumber,
      })

      if (replies.length) {
        allReplies.push(...replies)
        monitor.updateStats({
          currentPass: passNumber,
          repliesGenerated: allReplies.length,
        })

        const replyDisplayTurns = turnsToDisplayTurns(replies).displayTurns
        for (const t of replyDisplayTurns) {
          monitor.pushTurn(t)
        }

        if (flipRoles) break
      }
    }

    if (!allReplies.length) throw new Error("No response turns were generated.")

    // Schedule auto-replies as auto-steer messages for next session turn
    const scheduledMessages = new Set<string>()
    let scheduledCount = 0

    for (const reply of allReplies) {
      const replyText = extractText(reply.entry.message?.content).trim()
      if (!replyText) continue

      // Idempotency guard: dedup within batch to prevent duplicate messages in queue
      if (scheduledMessages.has(replyText)) {
        monitor.pushEvent(`[Auto-Steer] Skipped duplicate reply (already scheduled in batch)`)
        continue
      }

      scheduledMessages.add(replyText)

      try {
        const scheduled = await scheduleAutoSteer(sessionId, replyText, "next_turn", process.cwd())
        if (scheduled) {
          scheduledCount++
          monitor.pushEvent(
            `[Auto-Steer] ✓ Scheduled reply #${scheduledCount}: "${replyText.slice(0, 60)}..."`
          )
        } else {
          monitor.pushEvent(
            `[Auto-Steer] ⊘ Reply not scheduled (auto-steer disabled or terminal unsupported): "${replyText.slice(0, 60)}..."`
          )
        }
      } catch (err) {
        const errorMsg = messageFromUnknownError(err)
        monitor.pushEvent(`[Auto-Steer] ✗ Failed to schedule reply: ${errorMsg}`)
        // Fail-open: continue processing remaining replies
      }
    }

    monitor.setPhase("complete")
    monitor.pushEvent("Auto-reply generation complete")
  } finally {
    monitor.stop()
  }
}

// ─── Auto-reply streaming ───────────────────────────────────────────────────

function buildAutoReplyMessages(turns: Turn[], flipRoles: boolean): ModelMessage[] {
  const messages: ModelMessage[] = []
  for (const { entry, role } of turns) {
    if (role === "user") {
      const text = extractText(entry.message?.content).trim()
      if (text) {
        messages.push({
          role: flipRoles ? "assistant" : "user",
          content: text,
        })
      }
    } else {
      const blocks = toContentBlocks(entry.message?.content)
      const textParts = blocks.filter(isVisibleTextBlock).map((b) => b.text.trim())
      if (textParts.length > 0) {
        messages.push({
          role: flipRoles ? "user" : "assistant",
          content: textParts.join("\n"),
        })
      }
    }
  }
  messages.push({
    role: "user",
    content: "Continue - the session is NOT ready to finish.",
  })
  return messages
}

const AUTO_REPLY_SYSTEM = [
  "You are providing a follow-up directive to ensure the assistant (You) can continue making confident progress.",
  "Your follow-up should be written as a direct instruction in the second person tense (You Must, You Should, You May), or if referring to us both, the first person tense (We, Our, Us).",
  "Correct any self-direction or assistant direction which has finalisation intent. The session is far from over!",
].join()

async function consumeAutoReplyStream(
  fullStream: ReturnType<typeof streamText>["fullStream"],
  passNumber: number
): Promise<number> {
  let tokenCount = 0
  const reader = fullStream.getReader()
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if ("text" in value) {
        tokenCount++
        const state = monitor.getState()
        monitor.updateStats({
          tokensReceived: tokenCount,
          totalTokens: state.totalTokens + 1,
          streamingText: state.streamingText + value.text,
        })
      }
    }
  } finally {
    reader.releaseLock()
  }
  monitor.pushEvent(`Pass ${passNumber} complete (${tokenCount} tokens)`)
  monitor.updateStats({ streamingText: "" })
  return tokenCount
}

function extractTextFromResponseMessages(
  messages: Awaited<ReturnType<typeof streamText>["response"]>["messages"]
): string[] {
  const result: string[] = []
  for (const msg of messages) {
    if (!("content" in msg)) continue
    const parts = Array.isArray(msg.content) ? msg.content : [msg.content]
    for (const part of parts) {
      if (
        typeof part === "object" &&
        part !== null &&
        "type" in part &&
        part.type === "text" &&
        "text" in part
      ) {
        result.push(String(part.text))
      }
    }
  }
  return result
}

async function streamAutoReply(
  turns: Turn[],
  opts: { sessionId: string; flipRoles: boolean; cwd: string; passNumber: number }
): Promise<Turn[]> {
  const messages = buildAutoReplyMessages(turns, opts.flipRoles)

  const provider = createOpenRouter()
  const { response, fullStream } = streamText({
    model: provider.languageModel("openrouter/free"),
    messages: messages.slice(-20),
    system: AUTO_REPLY_SYSTEM,
    // Allow multi-step: model can call Read/Grep, get results,
    // then produce the final text reply
    stopWhen: stepCountIs(5),
    tools: {
      Read: readTool,
      Grep: grepTool,
    },
  })

  await consumeAutoReplyStream(fullStream, opts.passNumber)

  const awaitedResponse = await response
  const newTurns = extractTextFromResponseMessages(awaitedResponse.messages)

  return newTurns.map((t) => ({
    role: "user" as const,
    entry: {
      cwd: opts.cwd,
      type: "text" as const,
      timestamp: Date.now().toString(),
      message: { role: "user" as const, content: t },
    },
  }))
}

// ─── Command ────────────────────────────────────────────────────────────────

export { parseTranscriptArgs, type TranscriptArgs } from "../transcript-args.ts"

export const transcriptCommand: Command = {
  name: "transcript",
  description: "Display Agent-User chat history for the current project",
  usage:
    "swiz transcript [--session <id>] [--dir <path>] [--list] [--head N] [--tail N] [--hours N] [--since DATE] [--until DATE] [--auto-reply] [--include-debug] [--user-only] [--all|--claude|--cursor|--gemini|--codex|--junie]",
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
    { flags: "--junie", description: "Show Junie sessions only" },
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
      await runListMode(sessions, parsed.targetDir)
      return
    }

    const session = pickSession(sessions, parsed.sessionQuery)
    const { turns, debugEvents } = await loadSessionContent(
      session,
      parsed,
      timeRange,
      hasTimeFilter,
      (id) => console.log(`\n${DIM}Debug log not found for session: ${id}${RESET}`)
    )

    if (parsed.autoReply) {
      await runAutoReplyMode(turns, session.id, debugEvents)
    } else {
      await runDisplayMode(turns, session.id, debugEvents)
    }
  },
}
