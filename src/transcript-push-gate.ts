/**
 * Transcript scan for the preToolUse "no push when instructed" gate:
 * detect explicit user "do not push" instructions and optional subsequent
 * user-only push-approval phrases. Used by `pretooluse-no-push-when-instructed`.
 */

export const NO_PUSH_RE = /\bdo(?:n't| not)\s+push\b/i

export const PUSH_APPROVAL_PATTERNS: RegExp[] = [
  /\bgo ahead and push\b/i,
  /\bpush now\b/i,
  /^\/push(?:\s|$)/m,
  /\bplease push\b/i,
  // /push skill body (user invocation loads SKILL.md into the transcript). The opening
  // marketing line alone is not enough (see tests); these phrases are unique to push.md.
  /\bInvocation is authori[sz]ation\b/i,
  /\bexplicitly invokes\s+[`']?\/push[`']?/i,
]

export interface PushGateScanResult {
  /** Snippet of the line that matched the block, or empty if none */
  blockingLine: string
  /** True if a user message after the block matched an approval pattern */
  approvedAfter: boolean
}

const CONVERSATION_ROLES = new Set(["user", "assistant"])

function isTextBlock(block: unknown): string | null {
  const b = block as Record<string, any>
  return b?.type === "text" && typeof b?.text === "string" ? String(b.text) : null
}

function extractTextBlocks(entry: Record<string, any>): Array<{ role: string; text: string }> {
  const role: string = (entry?.type as string) ?? ""
  if (!CONVERSATION_ROLES.has(role)) return []
  const content = (entry as { message?: { content?: unknown[] } })?.message?.content
  if (!Array.isArray(content)) return []
  const results: Array<{ role: string; text: string }> = []
  for (const block of content) {
    const text = isTextBlock(block)
    if (text) {
      results.push({ role, text })
    }
  }
  return results
}

function extractBlockingSnippet(text: string): string {
  return (
    text
      .split("\n")
      .find((l) => NO_PUSH_RE.test(l))
      ?.trim() ?? text.slice(0, 120)
  )
}

function applyEntryToPushGateState(
  entry: Record<string, any>,
  state: PushGateScanResult
): void {
  for (const { role, text } of extractTextBlocks(entry)) {
    if (role !== "user") continue
    if (NO_PUSH_RE.test(text)) {
      state.blockingLine = extractBlockingSnippet(text)
      state.approvedAfter = false
    } else if (state.blockingLine && PUSH_APPROVAL_PATTERNS.some((re) => re.test(text))) {
      state.approvedAfter = true
    }
  }
}

export function createPushGateScanState(): PushGateScanResult {
  return { blockingLine: "", approvedAfter: false }
}

/**
 * Scan JSONL transcript lines (Claude session format) for push-gate state.
 * Ignores non-JSON lines. Restricts blocking and approval to user-role text blocks.
 */
export function scanPushGateFromJsonlLines(lines: string[]): PushGateScanResult {
  const state = createPushGateScanState()
  try {
    for (const line of lines) {
      if (!line.trim()) continue
      let entry: Record<string, any>
      try {
        entry = JSON.parse(line) as Record<string, any>
      } catch {
        continue
      }
      applyEntryToPushGateState(entry, state)
    }
  } catch {
    // Parity with hook: swallow unexpected errors, return partial state
  }
  return state
}
