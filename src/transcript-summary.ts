// ─── Transcript summary parser ──────────────────────────────────────────────
//
// Single-pass parser that extracts derived facts from a transcript JSONL file.
// dispatch.ts computes this once per cycle and injects it into hook payloads
// as `_transcriptSummary`. Extracted from hooks/hook-utils.ts (issue #84).

import { normalizeCommand } from "./command-utils.ts"
import { isShellTool } from "./tool-matchers.ts"

/**
 * Pre-parsed transcript summary injected by dispatch.ts into hook payloads.
 * Hooks should prefer consuming this over re-reading transcript_path.
 */
export interface TranscriptSummary {
  /** Every tool name called by the assistant, in order. */
  toolNames: string[]
  /** Total number of tool_use blocks (same as toolNames.length). */
  toolCallCount: number
  /** Normalized shell commands from Bash/Shell tool calls. */
  bashCommands: string[]
  /** Skill names invoked via the Skill tool. */
  skillInvocations: string[]
  /** Whether any Bash tool call contains `git push`. */
  hasGitPush: boolean
}

const GIT_PUSH_PATTERN = /\bgit\s+push\b/

/**
 * Parse a transcript JSONL string in a single pass and extract all derived
 * facts that hooks need. Returns a TranscriptSummary.
 */
export function parseTranscriptSummary(jsonlText: string): TranscriptSummary {
  const toolNames: string[] = []
  const bashCommands: string[] = []
  const skillInvocations: string[] = []
  let hasGitPush = false

  for (const line of jsonlText.split("\n")) {
    if (!line.trim()) continue
    try {
      const entry = JSON.parse(line)
      if (entry?.type !== "assistant") continue
      const content = entry?.message?.content
      if (!Array.isArray(content)) continue
      for (const block of content) {
        if (block?.type !== "tool_use") continue
        const name: string = block?.name ?? ""
        if (name) toolNames.push(name)

        // Extract bash commands
        if (isShellTool(name)) {
          const cmd: string = block?.input?.command ?? ""
          if (cmd) {
            bashCommands.push(normalizeCommand(cmd))
            if (!hasGitPush && GIT_PUSH_PATTERN.test(cmd)) hasGitPush = true
          }
        }

        // Extract skill invocations
        if (name === "Skill") {
          const skill: string = block?.input?.skill ?? ""
          if (skill) skillInvocations.push(skill)
        }
      }
    } catch {
      // Skip malformed lines
    }
  }

  return {
    toolNames,
    toolCallCount: toolNames.length,
    bashCommands,
    skillInvocations,
    hasGitPush,
  }
}

/**
 * Read a transcript file and compute the summary. Returns null if the file
 * is missing or unreadable.
 */
export async function computeTranscriptSummary(
  transcriptPath: string
): Promise<TranscriptSummary | null> {
  try {
    const text = await Bun.file(transcriptPath).text()
    return parseTranscriptSummary(text)
  } catch {
    return null
  }
}

/**
 * Extract the TranscriptSummary from a hook input payload (injected by dispatch).
 * Returns null if the summary is not present.
 */
export function getTranscriptSummary(input: Record<string, unknown>): TranscriptSummary | null {
  const summary = input?._transcriptSummary
  if (!summary || typeof summary !== "object") return null
  const s = summary as Record<string, unknown>
  if (!Array.isArray(s.toolNames)) return null
  return summary as TranscriptSummary
}
