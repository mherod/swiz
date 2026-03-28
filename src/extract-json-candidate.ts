/**
 * Extract a JSON candidate from AI response text.
 *
 * Strips fenced code blocks and locates the outermost { … } pair.
 * Shared by commands that parse structured JSON from AI provider output.
 */
export function extractJsonCandidate(text: string): string {
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
