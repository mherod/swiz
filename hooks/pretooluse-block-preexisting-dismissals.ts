#!/usr/bin/env bun
// PreToolUse hook: Block follow-up work when the assistant dismisses warnings,
// errors, or issues as "pre-existing" or "unrelated" without proving that claim
// from the transcript.
//
// Detects patterns such as:
//   - "pre-existing", "pre existing", "existed before"
//   - "unrelated to this refactor/change/PR"
//   - "only the pre-existing ... remains"
//   - "not introduced by this change"
//
// Correlates claims with the most recent lint/test/typecheck/build tool_result
// output. Only triggers when that output still contains warnings, errors,
// failures, or issue-style diagnostics.
//
// The gate clears when the transcript shows one of:
//   - A fix (file-modifying tool call after the claim)
//   - A scoped verification run (e.g. lint on specific files)
//   - Transcript-visible baseline evidence for the exact diagnostic

import { getTranscriptSummary } from "../src/transcript-summary.ts"
import { extractTextFromUnknownContent } from "../src/transcript-utils.ts"
import {
  denyPreToolUse,
  isCodeChangeTool,
  isGitRepo,
  isShellTool,
  readSessionLines,
} from "./hook-utils.ts"
import { toolHookInputSchema } from "./schemas.ts"

// ── Dismissal patterns ──────────────────────────────────────────────────────

const DISMISSAL_PATTERNS: RegExp[] = [
  /\bpre[- ]existing\b/i,
  /\bexisted before\b/i,
  /\bunrelated to (?:this |the )?(?:refactor|change|PR|commit|work|update)\b/i,
  /\bnot introduced by\b/i,
  /\bnot caused by\b/i,
  /\bno new (?:errors?|warnings?|issues?|failures?)\b/i,
  /\balready (?:present|there|existed|existing)\b/i,
  /\boutside (?:the )?(?:scope|change set)\b/i,
  /\bnot from (?:this |our |my )?(?:change|commit|refactor|work)\b/i,
  /\bpredates? (?:this |the |our |my )?(?:change|commit|refactor|work|PR)\b/i,
]

// ── Diagnostic output detection ─────────────────────────────────────────────

const DIAGNOSTIC_COMMAND_RE = /\b(?:lint|eslint|biome|typecheck|tsc|test|build|check)\b/i

const DIAGNOSTIC_OUTPUT_RE =
  /(?:\b(?:error|warning|fail(?:ed|ure)?|✖|✗|ERR!)\b|^\s*\d+:\d+\s+(?:error|warning)\b)/im

// ── Proof / clearing patterns ───────────────────────────────────────────────

const SCOPED_VERIFICATION_RE =
  /\b(?:lint|eslint|biome|typecheck|tsc|test|check)\b.*(?:--(?:filter|only|file|include)|\.(?:ts|tsx|js|jsx)\b)/i

const BASELINE_EVIDENCE_RE =
  /\b(?:git (?:diff|log|show|blame|stash)|baseline|before (?:this |the )?change|prior to|main branch)\b/i

// ── Transcript scanning ─────────────────────────────────────────────────────

interface ScanState {
  /** The most recent diagnostic output text (from tool_result). */
  lastDiagnosticOutput: string
  /** Whether diagnostic output contained actionable issues. */
  hasDiagnosticIssues: boolean
  /** The assistant's dismissal text, if any. */
  dismissalText: string
  /** The specific dismissal line found. */
  dismissalLine: string
  /** Whether the gate has been cleared by a proof step. */
  cleared: boolean
}

function extractAssistantText(entry: Record<string, unknown>): string {
  if (entry?.type !== "assistant") return ""
  const content = (entry as { message?: { content?: unknown } })?.message?.content
  return extractTextFromUnknownContent(content)
}

function extractToolResultText(entry: Record<string, unknown>): string {
  if (entry?.type !== "tool_result") return ""
  const content = (entry as { content?: unknown })?.content
  return extractTextFromUnknownContent(content)
}

function extractToolUse(
  entry: Record<string, unknown>
): { toolName: string; command: string } | null {
  if (entry?.type !== "assistant") return null
  const content = (entry as { message?: { content?: unknown[] } })?.message?.content
  if (!Array.isArray(content)) return null
  for (const block of content) {
    const b = block as Record<string, unknown>
    if (b?.type === "tool_use") {
      const toolName = String(b.name ?? "")
      const command = String((b.input as Record<string, unknown>)?.command ?? "")
      return { toolName, command }
    }
  }
  return null
}

function findDismissalLine(text: string): string | null {
  for (const line of text.split("\n")) {
    if (DISMISSAL_PATTERNS.some((re) => re.test(line))) {
      return line.trim()
    }
  }
  return null
}

function extractDiagnosticSnippet(output: string, maxLines: number = 5): string {
  const lines = output.split("\n")
  const diagnosticLines = lines.filter(
    (l) => /\b(?:error|warning|fail|✖|✗)\b/i.test(l) || /^\s*\d+:\d+\s+/.test(l)
  )
  return diagnosticLines.slice(0, maxLines).join("\n")
}

function resetDismissal(state: ScanState): void {
  state.dismissalText = ""
  state.dismissalLine = ""
  state.cleared = false
}

function processToolResult(resultText: string, state: ScanState): void {
  if (DIAGNOSTIC_OUTPUT_RE.test(resultText)) {
    state.lastDiagnosticOutput = resultText
    state.hasDiagnosticIssues = true
    resetDismissal(state)
  } else if (resultText.length > 10) {
    state.hasDiagnosticIssues = false
    resetDismissal(state)
  }
}

function isProofCommand(toolName: string, command: string): boolean {
  if (isCodeChangeTool(toolName)) return true
  if (!isShellTool(toolName)) return false
  return SCOPED_VERIFICATION_RE.test(command) || BASELINE_EVIDENCE_RE.test(command)
}

function processEntry(entry: Record<string, unknown>, state: ScanState): void {
  const resultText = extractToolResultText(entry)
  if (resultText) processToolResult(resultText, state)

  const toolUse = extractToolUse(entry)
  if (toolUse && state.dismissalText && isProofCommand(toolUse.toolName, toolUse.command)) {
    state.cleared = true
  }

  const text = extractAssistantText(entry)
  if (text && state.hasDiagnosticIssues && !state.cleared) {
    const line = findDismissalLine(text)
    if (line) {
      state.dismissalText = text
      state.dismissalLine = line
      state.cleared = false
    }
  }
}

function scanTranscript(lines: string[]): ScanState {
  const state: ScanState = {
    lastDiagnosticOutput: "",
    hasDiagnosticIssues: false,
    dismissalText: "",
    dismissalLine: "",
    cleared: false,
  }

  for (const line of lines) {
    if (!line.trim()) continue
    let entry: Record<string, unknown>
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    processEntry(entry, state)
  }

  return state
}

// ── Main ────────────────────────────────────────────────────────────────────

function isExemptShellCommand(command: string): boolean {
  return (
    DIAGNOSTIC_COMMAND_RE.test(command) ||
    SCOPED_VERIFICATION_RE.test(command) ||
    BASELINE_EVIDENCE_RE.test(command)
  )
}

function shouldSkipTool(toolName: string, toolInput: Record<string, unknown>): boolean {
  if (!isShellTool(toolName) && !isCodeChangeTool(toolName)) return true
  if (isShellTool(toolName) && isExemptShellCommand(String(toolInput?.command ?? ""))) return true
  return false
}

async function getSessionLines(
  raw: Record<string, unknown>,
  transcriptPath: string
): Promise<string[]> {
  const summary = getTranscriptSummary(raw)
  return summary?.sessionLines ?? (transcriptPath ? await readSessionLines(transcriptPath) : [])
}

function buildBlockMessage(state: ScanState): string {
  const diagnosticSnippet = extractDiagnosticSnippet(state.lastDiagnosticOutput)
  return (
    `BLOCKED: You claimed diagnostic issues are "pre-existing" or "unrelated" without proof.\n\n` +
    `Your claim:\n` +
    `  "${state.dismissalLine}"\n\n` +
    `But the most recent diagnostic output still shows issues:\n` +
    `${diagnosticSnippet ? `\`\`\`\n${diagnosticSnippet}\n\`\`\`\n\n` : ""}` +
    `To proceed, you must do one of:\n` +
    `  1. Fix the reported issues\n` +
    `  2. Run a scoped verification on only the changed files\n` +
    `  3. Provide transcript-visible baseline evidence (e.g. git diff, git log)\n` +
    `     proving the exact diagnostic predates your changes\n\n` +
    `Do not dismiss diagnostics without evidence. The linter/test output is the authority.`
  )
}

async function main() {
  const raw = await Bun.stdin.json()
  const input = toolHookInputSchema.parse(raw)

  const cwd = input.cwd ?? process.cwd()
  if (!(await isGitRepo(cwd))) process.exit(0)

  const toolName = input.tool_name ?? ""
  if (shouldSkipTool(toolName, input.tool_input ?? {})) process.exit(0)

  const sessionLines = await getSessionLines(raw, input.transcript_path ?? "")
  if (sessionLines.length === 0) process.exit(0)

  const state = scanTranscript(sessionLines)
  if (!state.hasDiagnosticIssues || !state.dismissalText || state.cleared) process.exit(0)

  denyPreToolUse(buildBlockMessage(state))
}

if (import.meta.main) {
  void main()
}
