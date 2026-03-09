import { basename, resolve } from "node:path"
import { z } from "zod"
import {
  type AiProviderId,
  hasAiProvider,
  promptObject,
  promptStreamText,
} from "../ai-providers.ts"
import { createStreamBufferReporter } from "../stream-buffer-reporter.ts"
import {
  extractPlainTurns,
  findAllProviderSessions,
  formatTurnsAsContext,
  getUnsupportedTranscriptFormatMessage,
  isUnsupportedTranscriptFormat,
  type Session,
} from "../transcript-utils.ts"
import type { Command } from "../types.ts"

const DEFAULT_TIMEOUT_MS = 90_000
const DEFAULT_MISTAKE_COUNT = 5
const TRANSCRIPT_CHAR_LIMIT = 48_000

const ReflectionMistakeSchema = z.object({
  label: z.string().min(3),
  whatHappened: z.string().min(20),
  whyWrong: z.string().min(20),
  whatToDoInstead: z.string().min(10),
})

const SessionReflectionSchema = (count: number) =>
  z.object({
    mistakes: z.array(ReflectionMistakeSchema).length(count),
  })

type SessionReflection = z.infer<ReturnType<typeof SessionReflectionSchema>>

export interface ReflectArgs {
  count: number
  targetDir: string
  sessionQuery: string | null
  model?: string
  timeoutMs: number
  json: boolean
  printPrompt: boolean
  provider?: AiProviderId
}

function parsePositiveInt(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer, got: ${value}`)
  }
  return parsed
}

export function parseReflectArgs(args: string[]): ReflectArgs {
  let count = DEFAULT_MISTAKE_COUNT
  let targetDir = process.cwd()
  let sessionQuery: string | null = null
  let model: string | undefined
  let timeoutMs = DEFAULT_TIMEOUT_MS
  let json = false
  let printPrompt = false
  let countSpecified = false
  let provider: AiProviderId | undefined

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg) continue
    const next = args[i + 1]

    if (arg === "--dir" || arg === "-d") {
      if (!next) throw new Error("Missing value for --dir")
      targetDir = resolve(next)
      i++
      continue
    }
    if (arg === "--session" || arg === "-s") {
      if (!next) throw new Error("Missing value for --session")
      sessionQuery = next
      i++
      continue
    }
    if (arg === "--model" || arg === "-m") {
      if (!next) throw new Error("Missing value for --model")
      model = next
      i++
      continue
    }
    if (arg === "--timeout" || arg === "-t") {
      if (!next) throw new Error("Missing value for --timeout")
      timeoutMs = parsePositiveInt(next, "--timeout")
      i++
      continue
    }
    if (arg === "--count" || arg === "-n") {
      if (!next) throw new Error(`Missing value for ${arg}`)
      if (countSpecified) throw new Error("Count already specified")
      count = parsePositiveInt(next, arg)
      countSpecified = true
      i++
      continue
    }
    if (arg === "--json" || arg === "-j") {
      json = true
      continue
    }
    if (arg === "--print-prompt" || arg === "-p") {
      printPrompt = true
      continue
    }
    if (arg === "--provider") {
      if (!next) throw new Error("Missing value for --provider")
      if (next !== "gemini" && next !== "codex" && next !== "claude") {
        throw new Error(`--provider must be "gemini", "codex", or "claude", got: ${next}`)
      }
      provider = next
      i++
      continue
    }
    if (!arg.startsWith("-")) {
      if (countSpecified) throw new Error("Count already specified")
      count = parsePositiveInt(arg, "count")
      countSpecified = true
      continue
    }
    throw new Error(`Unknown argument: ${arg}`)
  }

  return { count, targetDir, sessionQuery, model, timeoutMs, json, printPrompt, provider }
}

function truncateTranscript(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false }

  const head = Math.floor(maxChars * 0.45)
  const tail = maxChars - head
  return {
    text:
      `${text.slice(0, head)}\n\n` +
      `[conversation truncated to ${maxChars} characters to fit the reflection prompt]\n\n` +
      text.slice(-tail),
    truncated: true,
  }
}

async function loadTranscriptContext(
  targetDir: string,
  sessionQuery: string | null
): Promise<{ session: Session; context: string; turnCount: number; truncated: boolean }> {
  const sessions = await findAllProviderSessions(targetDir)

  if (sessions.length === 0) {
    throw new Error(`No transcripts found for: ${targetDir}`)
  }

  let session: Session
  if (sessionQuery) {
    const match = sessions.find((candidate) => candidate.id.startsWith(sessionQuery))
    if (!match) {
      throw new Error(`No session matching: ${sessionQuery}`)
    }
    session = match
  } else {
    session =
      sessions.find((candidate) => !isUnsupportedTranscriptFormat(candidate.format)) ?? sessions[0]!
  }

  if (isUnsupportedTranscriptFormat(session.format)) {
    throw new Error(getUnsupportedTranscriptFormatMessage(session))
  }

  let raw: string
  try {
    raw = await Bun.file(session.path).text()
  } catch {
    throw new Error(`Could not read transcript: ${session.path}`)
  }

  const turns = extractPlainTurns(raw)
  if (turns.length === 0) {
    throw new Error(`No conversation turns found in transcript: ${session.id}`)
  }

  const context = formatTurnsAsContext(turns)
  const truncated = truncateTranscript(context, TRANSCRIPT_CHAR_LIMIT)
  return {
    session,
    context: truncated.text,
    turnCount: turns.length,
    truncated: truncated.truncated,
  }
}

function buildPrompt(context: {
  count: number
  projectName: string
  targetDir: string
  sessionId: string
  provider: string
  turnCount: number
  transcript: string
  truncated: boolean
}): string {
  return [
    "You are reflecting on mistakes made by an AI assistant during a coding session.",
    "Read the conversation transcript carefully and identify concrete process failures.",
    "Do not soften, excuse, or downplay mistakes.",
    "Base every item on evidence from the transcript.",
    "If a pattern repeated, consolidate it into one mistake and mention the repetition.",
    `Identify exactly ${context.count} distinct mistakes, ordered from highest impact to lowest.`,
    "",
    "Each mistake must include:",
    '- `label`: a short label such as "Skipped verification" or "Wrong file target"',
    "- `whatHappened`: the concrete action taken, preferably naming commands, tools, paths, or decisions visible in the transcript",
    "- `whyWrong`: the specific consequence, wasted time, or risk created by that action",
    "- `whatToDoInstead`: a direct imperative describing the correct approach",
    "",
    "Mistake categories to consider:",
    "- wrong target",
    "- ignored prior knowledge",
    "- wrong tool or approach",
    "- stubborn retries",
    "- skipped verification",
    "- redundant work",
    "- incomplete triage",
    "- over-engineering or under-engineering",
    "- permission or denial misread",
    "- dead-end persistence",
    "",
    "Strict rules:",
    "- No praise, reassurance, or defensive language.",
    "- No vague advice.",
    "- Do not invent commands, files, or events that are not supported by the transcript.",
    "- If the transcript does not expose a concrete command, name the action at the highest supported specificity.",
    "- Write `whatToDoInstead` as a direct imperative.",
    "- Focus on substantive mistakes, not stylistic nitpicks.",
    "",
    "Output valid JSON only in this exact shape:",
    "{",
    '  "mistakes": [',
    "    {",
    '      "label": "...",',
    '      "whatHappened": "...",',
    '      "whyWrong": "...",',
    '      "whatToDoInstead": "..."',
    "    }",
    "  ]",
    "}",
    "",
    `Project: ${context.projectName}`,
    `Project directory: ${context.targetDir}`,
    `Session id: ${context.sessionId}`,
    `Transcript provider: ${context.provider}`,
    `Conversation turns provided: ${context.turnCount}`,
    `Transcript coverage: ${context.truncated ? "truncated for prompt budget" : "full transcript"}`,
    "",
    "<conversation_transcript>",
    context.transcript,
    "</conversation_transcript>",
  ].join("\n")
}

function ensureSentence(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) return trimmed
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`
}

function renderReflection(reflection: SessionReflection): string {
  return reflection.mistakes
    .map((mistake, index) => {
      const label = mistake.label.trim()
      const whatHappened = ensureSentence(mistake.whatHappened)
      const whyWrong = ensureSentence(mistake.whyWrong)
      const whatToDoInstead = ensureSentence(mistake.whatToDoInstead)
      return `${index + 1}. **${label}**: ${whatHappened} ${whyWrong} ${whatToDoInstead}`
    })
    .join("\n\n")
}

function extractJsonCandidate(text: string): string {
  const trimmed = text.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  if (fenced?.[1]) return fenced[1].trim()

  const firstBrace = trimmed.indexOf("{")
  const lastBrace = trimmed.lastIndexOf("}")
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1)
  }
  return trimmed
}

function parseReflectionFromJsonText(text: string, count: number): SessionReflection {
  const candidate = extractJsonCandidate(text)
  const parsed = JSON.parse(candidate)
  return SessionReflectionSchema(count).parse(parsed)
}

export const reflectCommand: Command = {
  name: "reflect",
  description: "Use Gemini to reflect on mistakes in a session transcript",
  usage:
    "swiz reflect [count] [--dir <path>] [--session <id>] [--model <name>] [--timeout <ms>] [--json] [--print-prompt]",
  options: [
    {
      flags: "[count]",
      description: `Number of mistakes to extract (default: ${DEFAULT_MISTAKE_COUNT})`,
    },
    { flags: "--count, -n <n>", description: "Explicit count override (same as positional count)" },
    { flags: "--dir, -d <path>", description: "Project directory to analyze (default: cwd)" },
    { flags: "--session, -s <id>", description: "Reflect on a specific session (prefix match)" },
    {
      flags: "--model, -m <name>",
      description: "Gemini model override (default: gemini-flash-latest)",
    },
    {
      flags: "--timeout, -t <ms>",
      description: `Gemini request timeout in ms (default: ${DEFAULT_TIMEOUT_MS})`,
    },
    {
      flags: "--json, -j",
      description: "Print structured reflection JSON instead of formatted markdown",
    },
    { flags: "--print-prompt, -p", description: "Print the generated prompt and exit" },
    {
      flags: "--provider <name>",
      description: 'AI provider override: "gemini", "codex", or "claude" (default: auto-select)',
    },
  ],
  async run(args: string[]) {
    const { count, targetDir, sessionQuery, model, timeoutMs, json, printPrompt, provider } =
      parseReflectArgs(args)
    const transcript = await loadTranscriptContext(targetDir, sessionQuery)
    const prompt = buildPrompt({
      count,
      projectName: basename(targetDir),
      targetDir,
      sessionId: transcript.session.id,
      provider: transcript.session.provider ?? "unknown",
      turnCount: transcript.turnCount,
      transcript: transcript.context,
      truncated: transcript.truncated,
    })

    if (printPrompt) {
      console.log(prompt)
      return
    }

    if (!hasAiProvider()) {
      throw new Error("No AI provider available. Set GEMINI_API_KEY or install the codex CLI.")
    }

    let reflection: SessionReflection
    const bufferReporter = createStreamBufferReporter({ enabled: !json })
    try {
      bufferReporter.startSubmitting()
      const streamed = await promptStreamText(prompt, {
        model,
        timeout: timeoutMs,
        provider,
        onTextPart: (textPart: string) => {
          if (json) {
            process.stdout.write(textPart)
            return
          }
          bufferReporter.onChunk(textPart)
        },
      })
      bufferReporter.finish()
      reflection = parseReflectionFromJsonText(streamed, count)
      if (json) {
        if (process.stdout.isTTY) process.stdout.write("\n")
        return
      }
    } catch (error) {
      bufferReporter.finish()
      // If raw JSON has already been streamed to stdout, avoid fallback output
      // that would produce mixed/duplicated content.
      if (json) throw error

      reflection = await promptObject(prompt, SessionReflectionSchema(count), {
        model,
        timeout: timeoutMs,
        provider,
      })
    }

    if (json) {
      console.log(JSON.stringify(reflection, null, 2))
      return
    }
    console.log(renderReflection(reflection))
  },
}
