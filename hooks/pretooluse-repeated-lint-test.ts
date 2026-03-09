#!/usr/bin/env bun
// PreToolUse hook: Block consecutive repeated lint/test/build commands of the
// same type (test, lint, or build) when no file-modifying tool call occurred
// between them. Prevents the wasteful pattern of re-running the same command
// with different output filters instead of reading the full output.
//
// "Uninterrupted" means: no file-modifying operation between the previous
// same-type run and the current one. Two complementary checks detect edits:
//   1. isCodeChangeTool — agent edit tools across all runtimes:
//        Edit / Write / NotebookEdit  (Claude Code)
//        StrReplace / EditNotebook    (Cursor)
//        replace / write_file / apply_patch  (Codex)
//   2. bashMutatesWorkspace — filesystem integrity monitor for out-of-band
//      mutations via raw shell commands (writes, deletions, moves, directories).
//      Checked independently from classifyCommand so that a classified command
//      that ALSO mutates (e.g. lint piped to tee) emits both events.

import { getTranscriptSummary } from "../src/transcript-summary.ts"
import { extractTextFromUnknownContent } from "../src/transcript-utils.ts"
import {
  collectBlockedToolUseIds,
  denyPreToolUse,
  formatActionPlan,
  isCodeChangeTool,
  isGitRepo,
  isShellTool,
  readSessionLines,
  stripAnsi,
} from "./hook-utils.ts"
import { toolHookInputSchema } from "./schemas.ts"
import { shellSegmentCommandRe } from "./utils/shell-patterns.ts"

// ── Command kind classification ───────────────────────────────────────────────

type CommandKind = "test" | "lint" | "typecheck" | "check" | "build"

const TEST_RE = shellSegmentCommandRe("bun\\s+test\\b")
const LINT_RE = shellSegmentCommandRe("bun\\s+run\\s+lint\\b")
const TYPECHECK_RE = shellSegmentCommandRe("bun\\s+run\\s+typecheck\\b")
const CHECK_RE = shellSegmentCommandRe("bun\\s+run\\s+check\\b")
const BUILD_RE = shellSegmentCommandRe("bun\\s+run\\s+build\\b")
const COMMAND_KIND_MATCHERS: ReadonlyArray<readonly [CommandKind, RegExp]> = [
  ["test", TEST_RE],
  ["lint", LINT_RE],
  ["typecheck", TYPECHECK_RE],
  ["check", CHECK_RE],
  ["build", BUILD_RE],
]

/** Returns true when the command is a help/usage query that should never be blocked. */
export function isHelpQuery(cmd: string): boolean {
  return /\s--help\b/.test(cmd)
}

export function classifyCommand(cmd: string): CommandKind | null {
  for (const [kind, pattern] of COMMAND_KIND_MATCHERS) {
    if (pattern.test(cmd)) return kind
  }
  return null
}

const COMMAND_LABEL: Record<CommandKind, string> = {
  test: "bun test",
  lint: "bun run lint",
  typecheck: "bun run typecheck",
  check: "bun run check",
  build: "bun run build",
}

// ── Command fingerprint ───────────────────────────────────────────────────────
// Returns a stable key that captures both the command kind AND the file/scope
// target. Two commands of the same kind but different targets (e.g.
// `bun test src/a.test.ts` vs `bun test src/b.test.ts`) produce different
// fingerprints and should NOT trigger the consecutive-run gate.
//
// For test commands, the scope is the set of path arguments (non-flag tokens
// that look like file paths or globs). For lint/typecheck/build commands the
// scope is always empty — their targets are project-wide and not path-scoped
// in our typical invocations.
//
// Returns null when the command does not match any known kind.

export function commandFingerprint(cmd: string): string | null {
  const kind = classifyCommand(cmd)
  if (!kind) return null

  if (kind !== "test") return kind

  // For test commands, extract non-flag tokens after `bun test` as scope,
  // stopping at the first pipe/redirect boundary so piped commands (tee, grep)
  // are not captured as scope targets.
  const afterBunTest = cmd.replace(/^.*bun\s+test\s*/, "")
  // Truncate at the first shell operator (pipe, redirect, logical AND/OR, semi)
  const beforePipe = afterBunTest.split(/\s*[|&;>]\s*/)[0] ?? ""
  const scopeTokens = beforePipe
    .split(/\s+/)
    .filter((t) => t && !t.startsWith("-") && !/^\d+$/.test(t))
    .sort()

  return scopeTokens.length > 0 ? `${kind}:${scopeTokens.join(",")}` : kind
}

// ── Filesystem integrity monitor ─────────────────────────────────────────────
// Detects bash commands that mutate workspace files or directories as a
// complement to isCodeChangeTool(). Covers all out-of-band mutations:
//   Writes:     shell redirects (> / >>), &> / &>>, N> / N>> numbered FD-to-file,
//               tee, in-place sed
//   CLI flags:  -o / --output / --outfile / --outdir and common variants
//   Deletions:  rm, trash, unlink
//   Moves/copies: mv, cp (structural changes)
//   Directories: mkdir, rmdir
//   Env-driven: KEY=./path prefix — command writes to a workspace-local path
//               controlled by an inline env var (e.g. OUTPUT_FILE=./r.json bun test)
// Conservative: excludes /dev/ special devices and pure FD-to-FD redirects (2>&1).

const WORKSPACE_MUTATION_PATTERNS: readonly RegExp[] = [
  // Plain output redirect: "> file" or ">> file"
  // (?<![0-9&]) excludes 2>&1-style FD redirects but also misses &> and N>.
  // Those are handled by dedicated patterns below.
  // IMPORTANT: exclusion lookaheads embed \s* internally so the engine cannot
  // backtrack the outer \s* to 0 and bypass the /dev/ exclusion.
  /(?<![0-9&])>>?(?!\s*\/dev\/)(?!\s*[&])/,
  // &> and &>> — bash shorthand for redirecting both stdout and stderr to a file
  /&>>?(?!\s*\/dev\/)(?!\s*[&>])/,
  // N> and N>> numbered FD-to-file redirects (e.g. 1> file, 2> file)
  /\d>>?(?!\s*\/dev\/)(?!\s*[&>])/,
  // tee to a named destination (not /dev/null or /dev/stderr)
  /\btee\s+(?!\/dev\/)/,
  // In-place sed/perl/ruby/awk operations
  /\bsed\b(?:[^|;]*\s+-[a-zA-Z]*i[a-zA-Z.]*|[^|;]*--in-place)/,
  /\bperl\b[^|;]*\s+-[a-zA-Z]*i[a-zA-Z.]*/,
  /\bruby\b[^|;]*\s+-[a-zA-Z]*i[a-zA-Z.]*/,
  /\b(?:g?awk)\b[^|;]*-i\s+inplace/,
  // patch applies diffs to files
  /\bpatch\b\s+/,
  // Python -c inline mutation operations
  /\bpython\d*\b[^|;]*-c\b.*\bopen\s*\([^)]*['"][wax][bt]?['"]/,
  /\bpython\d*\b[^|;]*-c\b.*\.(?:write(?:_text|_bytes)?|unlink|rename|replace|rmdir|mkdir|touch)\s*\(/,
  /\bpython\d*\b[^|;]*-c\b.*\bos\.(?:remove|unlink|rename|replace|makedirs|mkdir|rmdir)\s*\(/,
  /\bpython\d*\b[^|;]*-c\b.*\bshutil\.(?:copy2?|move|rmtree)\s*\(/,
  // Python -m formatters/fixers with in-place behavior
  /\bpython\d*\b[^|;]*-m\s+(?:black|isort|autopep8)\b/,
  /\bpython\d*\b[^|;]*-m\s+2to3\b[^|;]*-w\b/,
  // CLI output path flags
  /(?:^|\s)(?:-o|--(?:out(?:put|file|dir)?|report|log-?file))\s+\S/,
  /--(?:out(?:put|file|dir)?|report|log-?file)=\S/,
  // Generic file/directory mutations
  /\b(?:rm|trash|unlink)\s+/,
  /\b(?:mv|cp)\s+/,
  /\b(?:mkdir|rmdir)\b/,
  // Env-driven workspace-local output
  /\b[A-Z_]+=\.\//i,
  // Script-wrapper format/fix commands
  /\bbun\s+run\s+(?:format|lint[:-]fix|fix)\b/,
  /\bbiome\s+(?:format|check)\b[^|;]*--write\b/,
  /\beslint\b[^|;]*--fix\b/,
  /\bprettier\b[^|;]*(?:--write|-w)\b/,
]

export function bashMutatesWorkspace(cmd: string): boolean {
  return WORKSPACE_MUTATION_PATTERNS.some((pattern) => pattern.test(cmd))
}

// ── Transcript event types ───────────────────────────────────────────────────

export type EventKind = CommandKind | "any_edit"

export interface TranscriptEvent {
  kind: EventKind
  /** Scope-aware fingerprint for shell commands (kind + target paths).
   *  Used to distinguish `bun test src/a.test.ts` from `bun test src/b.test.ts`.
   *  Undefined for any_edit events and non-shell events. */
  fingerprint?: string
  /** JSONL source line index. Two events with the same index are from the
   *  same assistant message (parallel dispatch) and neither has been executed
   *  yet — they cannot be treated as a prior/current pair. */
  sourceLineIdx: number
}

export async function parseTranscriptEvents(
  transcriptPath: string,
  cachedSessionLines?: string[]
): Promise<TranscriptEvent[]> {
  const events: TranscriptEvent[] = []

  // Prefer pre-computed session lines injected by dispatch (_transcriptSummary.sessionLines).
  // readSessionLines handles compaction-boundary detection: only lines from
  // after the last {"type":"system"} entry (i.e. the current session) are
  // returned, preventing prior-session bun test calls from triggering the gate.
  const lines = cachedSessionLines ?? (await readSessionLines(transcriptPath))
  if (lines.length === 0) return events

  // Pre-pass: identify tool_use IDs whose executions were denied by a PreToolUse
  // hook. These never actually ran, so they must not count as prior runs.
  const blockedIds = collectBlockedToolUseIds(lines)

  let lineIdx = 0
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      const entry = JSON.parse(line)
      if (entry?.type !== "assistant") continue
      const content = entry?.message?.content
      if (!Array.isArray(content)) continue

      for (const block of content) {
        if (block?.type !== "tool_use") continue
        // Skip tool_use entries that were denied by a PreToolUse hook — they
        // never executed and should not trigger the consecutive-run gate.
        if (blockedIds.has(String(block.id ?? ""))) continue
        const name = String(block.name ?? "")
        const inp = block.input as Record<string, unknown> | undefined

        if (isShellTool(name)) {
          const cmd = String(inp?.command ?? "").normalize("NFKC")
          const kind = classifyCommand(cmd)
          if (kind) {
            const fingerprint = commandFingerprint(cmd) ?? kind
            events.push({ kind, fingerprint, sourceLineIdx: lineIdx })
            // A classified command (lint/test/build) may ALSO mutate the workspace
            // via a pipe or redirect in the same invocation — e.g.
            //   `bun run lint 2>&1 | tee output.txt`  (tee detected)
            //   `bun run build > dist-manifest.json`   (redirect detected)
            // Emit an any_edit event too so the gate does not block the next run.
            if (bashMutatesWorkspace(cmd)) events.push({ kind: "any_edit", sourceLineIdx: lineIdx })
          } else if (bashMutatesWorkspace(cmd))
            events.push({ kind: "any_edit", sourceLineIdx: lineIdx })
        } else if (isCodeChangeTool(name)) {
          // Any file-modifying tool counts as "intervening work" — covers all agents:
          // Edit/Write/NotebookEdit (Claude Code), StrReplace/EditNotebook (Cursor),
          // replace/write_file/apply_patch (Codex), and future tool types.
          events.push({ kind: "any_edit", sourceLineIdx: lineIdx })
        }
      }
    } catch {
      // Ignore malformed lines
    }
    lineIdx++
  }

  return events
}

// ── Remediation: surface errors from the previous same-kind run ───────────────
// Correlates the priorEvent.sourceLineIdx → tool_use_id in the assistant message
// → tool_result text in the subsequent user message. Parsed errors are appended
// to the block message so the agent knows exactly what to edit.

/** Extract the tool_use id for the first matching-kind bash call in a JSONL line. */
export function extractToolUseIdFromLine(line: string, kind: CommandKind): string | null {
  try {
    const entry = JSON.parse(line)
    if (entry?.type !== "assistant") return null
    const content = entry?.message?.content
    if (!Array.isArray(content)) return null
    for (const block of content) {
      if (block?.type !== "tool_use") continue
      if (!isShellTool(String(block.name ?? ""))) continue
      const cmd = String((block.input as Record<string, unknown>)?.command ?? "").normalize("NFKC")
      if (classifyCommand(cmd) === kind) return String(block.id ?? "") || null
    }
  } catch {
    // ignore malformed lines
  }
  return null
}

/** Read the tool_result text for a given tool_use_id from subsequent transcript lines. */
export async function extractPreviousOutput(
  transcriptPath: string,
  priorSourceLineIdx: number,
  kind: CommandKind,
  cachedLines?: string[]
): Promise<string> {
  let lines: string[]
  if (cachedLines) {
    lines = cachedLines.filter((l) => l.trim())
  } else {
    let text = ""
    try {
      text = await Bun.file(transcriptPath).text()
    } catch {
      return ""
    }
    lines = text.split("\n").filter((l) => l.trim())
  }
  const priorLine = lines[priorSourceLineIdx]
  if (!priorLine) return ""

  const toolUseId = extractToolUseIdFromLine(priorLine, kind)
  if (!toolUseId) return ""

  // Scan lines after the prior assistant message for the matching tool_result.
  for (let i = priorSourceLineIdx + 1; i < lines.length; i++) {
    try {
      const entry = JSON.parse(lines[i]!)
      if (entry?.type !== "user") continue
      const content = entry?.message?.content
      if (!Array.isArray(content)) continue
      for (const block of content) {
        if (block?.tool_use_id !== toolUseId) continue
        return extractTextFromUnknownContent(block.content)
      }
    } catch {
      // ignore malformed lines
    }
  }
  return ""
}

/**
 * Parse command output and return specific file/line error hints for the block message.
 *
 * Supported runners and patterns:
 *  - bun test:  `(fail)`, `✗` (U+2717)
 *  - Vitest:    `×` (U+00D7), `FAIL src/path.test.ts`, `AssertionError:`
 *  - Jest:      `●` (U+25CF) before test name, `✕` (U+2715), `FAIL src/path.test.ts`
 *  - Playwright: `✘` (U+2718), `N) [chromium/firefox/webkit] › …`, `.spec.ts:N`, `N failed`
 *  - Cypress:   `N failing`, `CypressError:`, `.cy.ts:N`
 *  - lint/build: `file.ts:N`, TypeScript `TS\d+` codes, `lint/ruleName`
 */
export function buildRemediationHints(output: string, kind: CommandKind): string {
  if (!output.trim()) return ""

  const clean = stripAnsi(output)
  const lines = clean.split("\n")
  const hits: string[] = []

  for (const line of lines) {
    const t = line.trim()
    if (!t || t.length > 200) continue

    const isError =
      kind === "test"
        ? // bun: (fail), ✗ (U+2717)
          // Vitest: × (U+00D7 multiplication sign), FAIL src/path.test.ts, AssertionError:
          // Jest:  ● before test name (U+25CF), ✕ (U+2715 cross mark), FAIL src/path.test.ts
          // Playwright: ✘ (U+2718 heavy ballot X), N) [chromium] › …, .spec.ts:N, N failed
          // Cypress:    N failing, CypressError:, .cy.ts:N
          /\(fail\)|[✗×✕✘]|●\s|AssertionError:|CypressError:|error:.*expect|expect.*received|\.(?:test|spec|cy)\.\w+:\d+|\bFAIL\s+\S+\.(?:test|spec)\.\w|\d+\)\s+\[(?:chromium|firefox|webkit)\]|\d+\s+fail(?:ed|ing)\b/i.test(
            t
          )
        : /\.(ts|tsx|js|jsx|json):\d+|\berror\b.*TS\d+|lint\/\w+/i.test(t)

    if (isError) {
      hits.push(t)
      if (hits.length >= 6) break
    }
  }

  if (hits.length === 0) return ""

  return (
    "\n\n**Specific issues from the previous run — edit these to clear the gate:**\n" +
    hits.map((h) => `  • ${h}`).join("\n")
  )
}

// ── Read-output step builder ─────────────────────────────────────────────────

/**
 * Build the action-plan step that directs the agent to read previous output.
 *
 * When a transcript path and source line index are available, the step includes
 * a concrete file reference so the agent can locate the output directly.
 * When the previous output could not be resolved (extractPreviousOutput returned
 * ""), the language is softened to acknowledge the output may not be available.
 */
export function buildReadOutputStep(
  label: string,
  transcriptPath: string,
  priorSourceLineIdx: number,
  prevOutput: string
): string {
  if (prevOutput) {
    // Output was successfully extracted — point to the exact transcript location.
    return [
      `Read the full output from the previous ${label} run`,
      `(transcript: \`${transcriptPath}\`, source line index: ${priorSourceLineIdx}).`,
    ].join(" ")
  }
  if (transcriptPath) {
    // Transcript exists but output extraction failed — provide the path with softer guidance.
    return [
      `Review the previous ${label} output. The transcript is at \`${transcriptPath}\``,
      `(source line index: ${priorSourceLineIdx}), but the prior output could not be extracted automatically —`,
      "check the transcript manually or review the errors shown below.",
    ].join(" ")
  }
  // No transcript path at all — generic fallback.
  return `Read the full output from the previous ${label} run.`
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const input = toolHookInputSchema.parse(await Bun.stdin.json())
  const toolName = input.tool_name ?? ""
  const cwd = input.cwd ?? process.cwd()
  const transcriptPath = input.transcript_path ?? ""

  if (!isShellTool(toolName)) return

  const command = String((input.tool_input as Record<string, unknown>)?.command ?? "").normalize(
    "NFKC"
  )

  const currentKind = classifyCommand(command)
  if (!currentKind) return

  // --help queries are informational, not repeated runs — never block them.
  if (isHelpQuery(command)) return

  if (!(await isGitRepo(cwd))) return
  if (!transcriptPath) return

  // Use pre-computed session lines from _transcriptSummary if available (injected
  // by dispatch.ts). Falls back to readSessionLines() when running standalone.
  const cachedSessionLines = getTranscriptSummary(
    input as unknown as Record<string, unknown>
  )?.sessionLines

  const events = await parseTranscriptEvents(transcriptPath, cachedSessionLines)

  // Claude Code writes the assistant message (including the current tool_use) to
  // the transcript BEFORE running PreToolUse hooks. So the current call is always
  // the LAST occurrence of its kind in the transcript. To find the prior call,
  // we need the second-to-last occurrence.
  //
  // Additionally, when the model emits two same-kind commands in a single
  // assistant message (parallel dispatch), both land in the transcript on the
  // same JSONL line simultaneously — neither has been executed yet. We require
  // the "prior" event to come from a different source line so that parallel
  // dispatches are never misidentified as a prior+current pair.
  const sameKindEvents = events.filter((e) => e.kind === currentKind)

  // Need at least 2 occurrences: one prior call + the current call (last in transcript)
  if (sameKindEvents.length < 2) return

  const currentEvent = sameKindEvents[sameKindEvents.length - 1]!
  const priorEvent = sameKindEvents[sameKindEvents.length - 2]!

  // Parallel dispatch guard: if both are from the same JSONL line, neither has
  // been executed yet — skip enforcement.
  if (priorEvent.sourceLineIdx === currentEvent.sourceLineIdx) return

  // Scope-fingerprint guard: if the commands target different paths/scopes,
  // they are semantically different commands — skip enforcement.
  // Example: `bun test src/a.test.ts` → `bun test src/b.test.ts` should be allowed.
  const currentFp = commandFingerprint(command) ?? currentKind
  if (priorEvent.fingerprint && priorEvent.fingerprint !== currentFp) return

  const lastPriorRunIdx = events.indexOf(priorEvent)

  // Check if any Edit/Write/Notebook happened between the prior run and current.
  // If so, the agent was acting on the output (real work) — allow the repeat.
  const hasInterveningWork = events.slice(lastPriorRunIdx + 1).some((e) => e.kind === "any_edit")

  if (hasInterveningWork) return

  // Block: consecutive repeat of the same command kind with no intervening work.
  const label = COMMAND_LABEL[currentKind]
  const firstLine = command.split("\n")[0]?.trim().slice(0, 80) ?? command.trim()

  // Extract specific errors from the previous run to guide remediation.
  // Reuse cached session lines to avoid a second file read.
  const prevOutput = await extractPreviousOutput(
    transcriptPath,
    priorEvent.sourceLineIdx,
    currentKind,
    cachedSessionLines
  )
  const remediationHints = buildRemediationHints(prevOutput, currentKind)

  // Build the "read previous output" step with a concrete file reference when available.
  const readStep = buildReadOutputStep(label, transcriptPath, priorEvent.sourceLineIdx, prevOutput)

  const blockMessage = [
    `**Consecutive ${label} blocked.**`,
    [
      `You ran \`${label}\` and immediately tried to run it again without editing any files in between.`,
      "This is the over-filtering pattern — re-running with different grep/tail flags instead of reading the full output.",
    ].join(" "),
    formatActionPlan([
      readStep,
      "Edit any file to signal you acted on the output, or update CLAUDE.md with a DO/DON'T rule.",
      `Then re-run without filters: \`${firstLine.replace(/\s*\|.*$/, "").trim()}\``,
    ]),
    remediationHints.trim(),
    "This gate clears once you edit any file — signalling you acted on the output rather than blindly retrying.",
  ]
    .filter(Boolean)
    .join("\n\n")

  denyPreToolUse(blockMessage)
}

if (import.meta.main) await main()
