import type { TextStreamPart, ToolSet } from "ai"

/** Consume SDK error events as failures instead of silently returning empty text. */
export async function readAiTextStream(
  stream: AsyncIterable<TextStreamPart<ToolSet>>,
  signal?: AbortSignal,
  onTextPart?: (text: string) => void
): Promise<string> {
  let text = ""
  for await (const part of stream) {
    signal?.throwIfAborted()
    if (part.type === "error") throw part.error
    if (part.type === "text-delta") {
      text += part.text
      onTextPart?.(part.text)
    }
  }
  signal?.throwIfAborted()
  if (!text.trim()) throw new Error("AI provider returned no text.")
  return text.trim()
}
