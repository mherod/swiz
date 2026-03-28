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
//   - "an existing issue/bug" (dodges "pre-" prefix)
//   - "already broken/failing" (extends "already present/there")
//   - "I didn't cause/introduce/break this"
//   - "nothing to do with my changes"
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
import { toolHookInputSchema } from "./schemas.ts"
import {
  allowPreToolUse,
  denyPreToolUse,
  isCodeChangeTool,
  isGitRepo,
  isShellTool,
  readAllTranscriptLines,
} from "./utils/hook-utils.ts"
import { stripQuotedShellStrings } from "./utils/shell-patterns.ts"

// ── Dismissal patterns ──────────────────────────────────────────────────────

const DISMISSAL_PATTERNS: RegExp[] = [
  /\bpre[- ]existing\b/i,
  /\bexisted before\b/i,
  /\bunrelated to (?:this |the )?(?:refactor|change|PR|commit|work|update)\b/i,
  /\bnot introduced by\b/i,
  /\bnot caused by\b/i,
  /\bno new (?:errors?|warnings?|issues?|failures?)\b/i,
  /\balready (?:present|there|existed|existing|broken|failing)\b/i,
  /\boutside (?:the )?(?:scope|change set)\b/i,
  /\bnot from (?:this |our |my )?(?:change|commit|refactor|work)\b/i,
  /\bpredates? (?:this |the |our |my )?(?:change|commit|refactor|work|PR)\b/i,
  // "an existing issue" / "this existing bug" — dodges "pre-existing" without the prefix
  /\b(?:an? )?existing (?:issue|error|warning|problem|bug|failure|defect)\b/i,
  // "I didn't cause/introduce/break this" — first-person authorship denial
  /\bi (?:didn't|did not|haven't|have not) (?:write|cause|introduce|create|break|add|touch) (?:this|that|it)\b/i,
  // "nothing to do with my changes" — alternate phrasing of "unrelated to"
  /\bnothing to do with (?:my|our|the|this|these) (?:change|work|edit|update|commit|fix|changes|edits|updates)\b/i,
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
  /** Whether the last tool_use was a diagnostic command (lint/test/typecheck/build). */
  lastToolWasDiagnostic: boolean
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

function parseToolUseBlock(block: unknown): { toolName: string; command: string } | null {
  const b = block as Record<string, unknown>
  if (b?.type !== "tool_use") return null
  return {
    toolName: String(b.name ?? ""),
    command: String((b.input as Record<string, unknown>)?.command ?? ""),
  }
}

function extractToolUse(
  entry: Record<string, unknown>
): { toolName: string; command: string } | null {
  if (entry?.type !== "assistant") return null
  const content = (entry as { message?: { content?: unknown[] } })?.message?.content
  if (!Array.isArray(content)) return null
  for (const block of content) {
    const result = parseToolUseBlock(block)
    if (result) return result
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
  } else if (resultText.length > 10 && state.lastToolWasDiagnostic) {
    // Only clear hasDiagnosticIssues when a diagnostic command (lint/test/typecheck)
    // produces clean output — this is the "re-ran and it passed" case.
    // Non-diagnostic tool results (task completions, file reads, etc.) must NOT
    // erase the diagnostic context that the dismissal claim refers to.
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
  if (toolUse) {
    // Track whether this tool call is a diagnostic command so that its result
    // can clear hasDiagnosticIssues when clean (but non-diagnostic results won't).
    state.lastToolWasDiagnostic =
      isShellTool(toolUse.toolName) &&
      DIAGNOSTIC_COMMAND_RE.test(stripQuotedShellStrings(toolUse.command, { stripBackticks: true }))

    if (state.dismissalText && isProofCommand(toolUse.toolName, toolUse.command)) {
      state.cleared = true
    }
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
    lastToolWasDiagnostic: false,
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
  // Strip quoted argument values before checking diagnostic patterns.
  // This prevents false exemptions when arguments (e.g. --evidence "tests pass") contain
  // diagnostic keywords like "test", "check", etc.
  const unquoted = stripQuotedShellStrings(command, { stripBackticks: true })
  if (DIAGNOSTIC_COMMAND_RE.test(unquoted)) return true
  // Scoped verification and baseline evidence need the full command to match flags/paths
  if (SCOPED_VERIFICATION_RE.test(command)) return true
  if (BASELINE_EVIDENCE_RE.test(command)) return true
  return false
}

function shouldSkipTool(toolName: string, toolInput: Record<string, unknown>): boolean {
  if (!isShellTool(toolName) && !isCodeChangeTool(toolName)) return true
  if (isShellTool(toolName) && isExemptShellCommand(String(toolInput?.command ?? ""))) return true
  return false
}

async function getAllTranscriptLines(
  raw: Record<string, unknown>,
  transcriptPath: string
): Promise<string[]> {
  // Read full transcript (not just session lines) so cross-session dismissals are detected.
  // Fall back to session lines from the summary if transcript_path is unavailable.
  if (transcriptPath) return readAllTranscriptLines(transcriptPath)
  const summary = getTranscriptSummary(raw)
  return summary?.sessionLines ?? []
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

function resolveAllowReason(state: ScanState): string | null {
  if (state.cleared) return "Pre-existing dismissal cleared via evidence"
  if (!state.dismissalText) return "No pre-existing dismissal detected"
  if (!state.hasDiagnosticIssues) return "No diagnostic issues in recent output"
  return null
}

async function resolveTranscriptContext(
  raw: Record<string, unknown>,
  input: ReturnType<typeof toolHookInputSchema.parse>
): Promise<string[] | null> {
  const cwd = input.cwd ?? process.cwd()
  if (!(await isGitRepo(cwd))) return null
  const toolName = input.tool_name ?? ""
  if (shouldSkipTool(toolName, input.tool_input ?? {})) return null
  const lines = await getAllTranscriptLines(raw, input.transcript_path ?? "")
  return lines.length > 0 ? lines : null
}

async function main() {
  const raw = await Bun.stdin.json()
  const input = toolHookInputSchema.parse(raw)

  const lines = await resolveTranscriptContext(raw, input)
  if (!lines) process.exit(0)

  const state = scanTranscript(lines)
  const allowReason = resolveAllowReason(state)
  if (allowReason) allowPreToolUse(allowReason)

  denyPreToolUse(buildBlockMessage(state))
}

if (import.meta.main) {
  void main()
}
