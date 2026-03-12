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
  /**
   * Raw JSONL lines from the current session only (post-compaction boundary).
   * Mirrors the output of readSessionLines() from hook-utils.ts.
   * Hooks that previously called readSessionLines() or Bun.file(transcriptPath).text()
   * should consume this field instead to avoid redundant I/O.
   */
  sessionLines: string[]
}

const GIT_PUSH_PATTERN = /\bgit\s+push\b/

/**
 * Extract session-boundary-aware lines from a full transcript text.
 * Mirrors readSessionLines() in hook-utils.ts: returns only lines after the
 * last {"type":"system"} entry (i.e. post-compaction) so pre-session content
 * is excluded from hook checks.
 */
export function extractSessionLines(jsonlText: string): string[] {
  const allLines = jsonlText.split("\n")
  let sessionStartIdx = 0
  for (let i = allLines.length - 1; i >= 0; i--) {
    const raw = allLines[i]
    if (!raw?.trim()) continue
    try {
      const parsed = JSON.parse(raw) as { type?: string }
      if (parsed?.type === "system") {
        sessionStartIdx = i + 1
        break
      }
    } catch {
      // ignore malformed lines
    }
  }
  return sessionStartIdx > 0 ? allLines.slice(sessionStartIdx) : allLines
}

/**
 * Parse a transcript JSONL string in a single pass and extract all derived
 * facts that hooks need. Returns a TranscriptSummary.
 */
export function parseTranscriptSummary(jsonlText: string): TranscriptSummary {
  const toolNames: string[] = []
  const bashCommands: string[] = []
  const skillInvocations: string[] = []
  let hasGitPush = false

  // Compute session-boundary-aware lines once; reuse for both parsing and storage.
  const sessionLines = extractSessionLines(jsonlText)

  for (const line of sessionLines) {
    if (!line.trim()) continue
    try {
      const entry = JSON.parse(line) as {
        type?: string
        message?: {
          content?: Array<{
            type?: string
            name?: string
            input?: { command?: string; skill?: string }
          }>
        }
      }
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
    sessionLines,
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
