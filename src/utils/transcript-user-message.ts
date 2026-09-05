import { tryParseJsonLine } from "./jsonl.ts"
import { reverseJsonlLines } from "./jsonl-reverse.ts"

export interface TranscriptUserMessage {
  text: string
  at: number | null
}

function userText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  if (content.some((block) => block?.type === "tool_result")) return ""
  return content
    .filter(
      (block) => ["text", "input_text"].includes(block?.type) && typeof block.text === "string"
    )
    .map((block) => block.text)
    .join("\n")
}

function userContent(entry: Record<string, any>): unknown {
  if (["user", "human"].includes(entry.type)) return entry.message?.content ?? entry.content
  const payload = entry.payload ?? {}
  if (entry.type === "response_item")
    return payload.type === "message" && payload.role === "user" ? payload.content : null
  if (entry.type === "event_msg") return payload.type === "user_message" ? payload.message : null
  return null
}

function extractUserMessage(line: string): TranscriptUserMessage | null {
  if (!line.includes('"user"') && !line.includes('"human"') && !line.includes('"user_message"'))
    return null
  const parsed = tryParseJsonLine(line)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  return userMessage(parsed as Record<string, any>)
}

function userMessage(entry: Record<string, any>): TranscriptUserMessage | null {
  const text = userText(userContent(entry))
  if (!text.trim()) return null
  const at = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN
  return { text, at: Number.isFinite(at) ? at : null }
}

/** Latest human message across Claude and Codex transcripts, with bounded allocations. */
export async function readLastTranscriptUserMessage(
  path: string,
  requireTimestamp = false
): Promise<TranscriptUserMessage | null> {
  try {
    const file = Bun.file(path)
    const { size } = await file.stat()
    for await (const line of reverseJsonlLines(file, size)) {
      const message = extractUserMessage(line)
      if (message && (!requireTimestamp || message.at !== null)) return message
    }
  } catch {}
  return null
}
