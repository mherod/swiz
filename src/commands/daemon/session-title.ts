import type { SessionMessage } from "./utils.ts"

/** A bounded prompt label; never use injected workspace instructions as a session title. */
export function sessionTitleFromMessages(messages: readonly SessionMessage[]): string | undefined {
  for (const message of messages) {
    if (message.role !== "user") continue
    const text = message.text.trim()
    if (!text || /^#\s*AGENTS\.md\b/i.test(text)) continue
    if (
      /^<(?:environment_context|instructions|user_instructions|system-reminder|permissions)\b/i.test(
        text
      )
    )
      continue
    const firstLine = text.split("\n").find((line) => line.trim()) ?? ""
    const title = firstLine
      .replace(/^#+\s*|^Human:\s*/i, "")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/\s+/g, " ")
      .trim()
    if (title) return title.length > 96 ? `${title.slice(0, 95)}…` : title
  }
  return undefined
}
