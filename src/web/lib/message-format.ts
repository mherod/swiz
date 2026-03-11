interface ParsedHookContext {
  source: string | null
  details: Array<{ label: string; value: string }>
  notes: string[]
}

export interface UserMessageParts {
  visibleText: string
  hookContext: ParsedHookContext | null
}

export interface AssistantMessageParts {
  visibleText: string
  thoughtText: string | null
}

function isMarkdownLike(text: string): boolean {
  return /(^|\n)\s*(#{1,6}\s|[-*]\s|>\s|```)|`[^`]+`|\[[^\]]+\]\([^)]+\)/m.test(text)
}

export function normalizeAssistantText(text: string): string {
  if (isMarkdownLike(text)) return text
  if (text.length < 300) return text
  const newlineCount = (text.match(/\n/g) ?? []).length
  if (newlineCount > 8) return text
  return text
    .replace(/\. (?=[A-Z][a-z]{2,}\b)/g, ".\n\n")
    .replace(/\) (?=[A-Z][a-z]{2,}\b)/g, ")\n\n")
    .replace(/: (?=[A-Z][a-z]{2,}\b)/g, ":\n")
}

export function splitAssistantMessage(text: string): AssistantMessageParts {
  const thoughts: string[] = []
  const visibleText = text
    .replace(/<thought>([\s\S]*?)(?:<\/thought>|$)/gi, (_, inner: string) => {
      const cleaned = inner.trim()
      if (cleaned) thoughts.push(cleaned)
      return ""
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim()

  const thoughtText = thoughts.join("\n\n").trim()
  return {
    visibleText,
    thoughtText: thoughtText.length > 0 ? thoughtText : null,
  }
}

export function splitUserMessage(text: string): UserMessageParts {
  const marker = "<hook_context>"
  const markerIndex = text.indexOf(marker)
  if (markerIndex < 0) {
    return { visibleText: text.trim(), hookContext: null }
  }

  const visibleText = text.slice(0, markerIndex).trim()
  const rawContext = text.slice(markerIndex + marker.length).trim()
  if (!rawContext) {
    return { visibleText, hookContext: null }
  }

  let source: string | null = null
  let remaining = rawContext
  const sourceMatch = /^\[([^\]]+)\]\s*/.exec(remaining)
  if (sourceMatch?.[1]) {
    source = sourceMatch[1]
    remaining = remaining.slice(sourceMatch[0].length).trim()
  }

  const details: Array<{ label: string; value: string }> = []
  const notes: string[] = []

  // Extract common key/value metadata from hook output.
  const branchMatch = /branch:\s*([^\s|]+)/i.exec(remaining)
  if (branchMatch?.[1]) {
    details.push({ label: "branch", value: branchMatch[1].trim() })
  }

  const dirtyMatch = /uncommitted files:\s*(\d+)/i.exec(remaining)
  if (dirtyMatch?.[1]) {
    details.push({ label: "uncommitted", value: dirtyMatch[1].trim() })
  }

  const priorTaskMatch = /Prior session.*?incomplete task\(s\)\./i.exec(remaining)
  if (priorTaskMatch?.[0]) {
    notes.push(priorTaskMatch[0].trim())
  }

  const recoveryCmdMatch = /If already done,\s*run:\s*([^\n]+)$/i.exec(remaining)
  if (recoveryCmdMatch?.[1]) {
    details.push({ label: "recovery", value: recoveryCmdMatch[1].trim() })
  }

  if (details.length === 0 && notes.length === 0) {
    notes.push(remaining)
  }

  return {
    visibleText,
    hookContext: { source, details, notes },
  }
}

function tryParseJson(text: string): string | null {
  const candidate = text.trim()
  if (!(candidate.startsWith("{") || candidate.startsWith("["))) return null
  try {
    const parsed = JSON.parse(candidate)
    return JSON.stringify(parsed, null, 2)
  } catch {
    return null
  }
}

function normalizeInlineFencedCode(text: string): string {
  if (!text.includes("```")) return text
  const normalized = text.replace(
    /```([a-zA-Z0-9_-]*)\s*([\s\S]*?)```/g,
    (_match: string, lang: string, code: string) => `\n\`\`\`${lang}\n${code.trim()}\n\`\`\`\n`
  )
  return normalized.replace(/\n{3,}/g, "\n\n").trim()
}

export function formatAssistantJsonBlocks(text: string): string {
  if (!text) return text
  const withNormalizedFences = normalizeInlineFencedCode(text)
  if (withNormalizedFences.includes("```")) return withNormalizedFences

  const wholeJson = tryParseJson(withNormalizedFences)
  if (wholeJson) return `\`\`\`json\n${wholeJson}\n\`\`\``

  // Common case: prose prefix followed by a JSON payload (for example API errors).
  const firstBrace = withNormalizedFences.indexOf("{")
  const firstBracket = withNormalizedFences.indexOf("[")
  const startCandidates = [firstBrace, firstBracket].filter((idx) => idx >= 0)
  if (startCandidates.length === 0) return withNormalizedFences
  const start = Math.min(...startCandidates)

  const jsonLike = withNormalizedFences.slice(start).trim()
  const parsed = tryParseJson(jsonLike)
  if (!parsed) return withNormalizedFences

  const prefix = withNormalizedFences.slice(0, start).trimEnd()
  if (!prefix) return `\`\`\`json\n${parsed}\n\`\`\``
  return `${prefix}\n\n\`\`\`json\n${parsed}\n\`\`\``
}
