#!/usr/bin/env bun
// PreToolUse hook: Block consecutive repeated lint/test/build commands of the
// same type (test, lint, or build) when no file-modifying tool call occurred
// between them. Prevents the wasteful pattern of re-running the same command
// with different output filters instead of reading the full output.
//
// Supports: bun, npm, pnpm, yarn, turbo, nx, and direct test runners
// (jest, vitest, pytest, cargo test, go test, phpunit, rspec, dotnet test, mocha, ava).
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

import { orderBy } from "lodash-es"
import { runSwizHookAsMain, type SwizHookOutput, type SwizToolHook } from "../src/SwizHook.ts"
import { toolHookInputSchema } from "../src/schemas.ts"
import { getTranscriptSummary } from "../src/transcript-summary.ts"
import { extractTextFromUnknownContent } from "../src/transcript-utils.ts"
import {
  collectBlockedToolUseIds,
  formatActionPlan,
  isCodeChangeTool,
  isGitRepo,
  isShellTool,
  preToolUseDeny,
  readSessionLines,
  stripAnsi,
} from "../src/utils/hook-utils.ts"
import { shellSegmentCommandRe } from "../src/utils/shell-patterns.ts"

// ── Command kind classification ───────────────────────────────────────────────

type CommandKind = "test" | "lint" | "typecheck" | "check" | "build"

// Package manager "run" patterns that precede \s+<scriptName>.
// Each alternative must end at a word boundary or \s, so that buildKindRe
// can append \s+<scriptName> without double-spacing.
//   bun run, npm run, pnpm run, pnpm exec, yarn run → end with "run" or "exec"
//   yarn, pnpm, npx, bunx → bare invocations (yarn test, pnpm test, npx test)
const PM_RUN = String.raw`(?:bun\s+run|npm\s+run|pnpm\s+(?:run|exec)|yarn\s+run|yarn|pnpm|npx|bunx)`

// Monorepo orchestrators that wrap package scripts:
//   pnpm turbo run <script>, npx turbo run <script>, turbo run <script>, turbo <script>
//   pnpm nx run <target>, nx run <target>, nx <target>, nx run-many --target=<target>
const TURBO_PREFIX = String.raw`(?:(?:pnpm|npx|bunx|yarn)\s+)?turbo\s+(?:run\s+)?`
const NX_PREFIX = String.raw`(?:(?:pnpm|npx|bunx|yarn)\s+)?nx\s+(?:run\s+)?`
const NX_RUN_MANY = String.raw`(?:(?:pnpm|npx|bunx|yarn)\s+)?nx\s+run-many\b`

// Direct test runner invocations (not behind a package manager)
const DIRECT_TEST = String.raw`(?:jest|vitest|pytest|cargo\s+test|go\s+test|phpunit|rspec|dotnet\s+test|mocha|ava)\b`

// Build each kind matcher as an array of patterns, then combine with alternation.
// Order matters: more specific patterns (turbo/nx) before generic PM patterns.
function buildKindRe(scriptName: string, extras: string[] = []): RegExp {
  const patterns = [
    // turbo run <script>
    `${TURBO_PREFIX}${scriptName}\\b`,
    // nx run <script> / nx <script>
    `${NX_PREFIX}${scriptName}\\b`,
    // <pm> run <script>
    `${PM_RUN}\\s+${scriptName}\\b`,
    // bun <script> (bun allows bare script names)
    `bun\\s+${scriptName}\\b`,
    ...extras,
  ]
  return shellSegmentCommandRe(`(?:${patterns.join("|")})`)
}

// nx run-many needs special handling: --target=<script> appears as a flag
function buildNxRunManyRe(scriptName: string): RegExp {
  return shellSegmentCommandRe(`${NX_RUN_MANY}[^|;&]*--target[=\\s]+${scriptName}\\b`)
}

const TEST_RE = buildKindRe("test", [
  // bun test (bun's built-in test runner, distinct from "bun run test")
  String.raw`bun\s+test\b`,
  // Direct test runner invocations
  DIRECT_TEST,
])
const LINT_RE = buildKindRe("lint")
const TYPECHECK_RE = buildKindRe("typecheck")
const CHECK_RE = buildKindRe("check")
const BUILD_RE = buildKindRe("build")

const NX_TEST_RE = buildNxRunManyRe("test")
const NX_LINT_RE = buildNxRunManyRe("lint")
const NX_TYPECHECK_RE = buildNxRunManyRe("typecheck")
const NX_CHECK_RE = buildNxRunManyRe("check")
const NX_BUILD_RE = buildNxRunManyRe("build")

const COMMAND_KIND_MATCHERS: ReadonlyArray<readonly [CommandKind, RegExp]> = [
  ["test", TEST_RE],
  ["test", NX_TEST_RE],
  ["lint", LINT_RE],
  ["lint", NX_LINT_RE],
  ["typecheck", TYPECHECK_RE],
  ["typecheck", NX_TYPECHECK_RE],
  ["check", CHECK_RE],
  ["check", NX_CHECK_RE],
  ["build", BUILD_RE],
  ["build", NX_BUILD_RE],
]

/** Returns true when the command is a help/usage query that should never be blocked. */
export function isHelpQuery(cmd: string): boolean {
  return /\s--help\b/.test(cmd)
}

// Matches one or more command-prefix wrappers at the start of a (trimmed) shell segment.
// These wrappers don't change the command's kind, but they prevent the segment-boundary
// regex from matching because `bun test` is no longer at a boundary.
// Handles: timeout [N], nice [-n N], env, command, sudo [-flag [val]...], time
const SEGMENT_PREFIX_RE =
  /^(?:(?:timeout\s+\d+|nice(?:\s+-n\s*[-\d]+)?|env|command|sudo(?:\s+-\S+(?:\s+\S+)?)*|time)\s+)+/

/** Strip common command-prefix wrappers from each shell segment so classification sees the real command. */
function normalizeCommand(cmd: string): string {
  // Split on shell operators (|, &, ;), trim each segment, strip wrappers, then rejoin.
  return cmd
    .split(/([|;&])/)
    .map((part, i) => (i % 2 === 0 ? part.trim().replace(SEGMENT_PREFIX_RE, "") : part))
    .join("")
}

export function classifyCommand(cmd: string): CommandKind | null {
  const normalized = normalizeCommand(cmd)
  for (const [kind, pattern] of COMMAND_KIND_MATCHERS) {
    if (pattern.test(normalized)) return kind
  }
  return null
}

/**
 * Derive a human-readable label from the actual command.
 * Extracts the core invocation (e.g. "pnpm turbo run build", "npm run test")
 * by stripping pipe suffixes, redirect suffixes, and trimming to a reasonable length.
 * Falls back to "test"/"build"/etc. if extraction fails.
 */
export function commandLabel(cmd: string, kind: CommandKind): string {
  // Strip everything after the first pipe or semicolon boundary.
  // Keep > because it may be part of 2>&1 FD redirects, not file redirects.
  const core = cmd.split(/\s*[|;]\s*/)[0]?.trim() ?? ""
  // Remove prefix wrappers (timeout, nice, env, etc.) for a cleaner label
  const cleaned = normalizeCommand(core).trim()
  // Truncate to a reasonable length for display
  if (cleaned.length > 0 && cleaned.length <= 60) return cleaned
  if (cleaned.length > 60) return `${cleaned.slice(0, 57)}...`
  return kind
}

// ── Command fingerprint ───────────────────────────────────────────────────────
// Returns a stable key that captures both the command kind AND the file/scope
// target. Two commands of the same kind but different targets (e.g.
// `bun test src/a.test.ts` vs `bun test src/b.test.ts`) produce different
// fingerprints and should NOT trigger the consecutive-run gate.
//
// Scope extraction strategies:
//   - turbo --filter:  `pnpm turbo run build --filter=app-a` → "build:app-a"
//   - nx --projects:   `nx run-many --target=build --projects=app-a` → "build:app-a"
//   - test file paths: `bun test src/a.test.ts` → "test:src/a.test.ts"
//   - unscoped:        `npm run lint` → "lint"
//
// Returns null when the command does not match any known kind.

/** Extract turbo --filter values from a command string. */
function extractTurboFilters(cmd: string): string[] {
  // Matches --filter=value and --filter value (short form not supported by turbo)
  const matches = [...cmd.matchAll(/--filter[=\s]+(\S+)/g)]
  return matches.map((m) => m[1]!).filter(Boolean)
}

/** Extract nx --projects values from a command string. */
function extractNxProjects(cmd: string): string[] {
  // Matches --projects=value and --projects value (comma-separated lists)
  const matches = [...cmd.matchAll(/--projects?[=\s]+(\S+)/g)]
  return matches.flatMap((m) => (m[1] ?? "").split(",")).filter(Boolean)
}

/** Extract test file path arguments from a test command. */
function extractTestScope(cmd: string): string[] {
  // Strip everything up to and including the test runner keyword
  const afterRunner = cmd.replace(
    /^.*(?:bun\s+test|jest|vitest|mocha|ava|pytest|rspec|phpunit|cargo\s+test|go\s+test|dotnet\s+test)\s*/,
    ""
  )
  // Truncate at the first shell operator (pipe, redirect, logical AND/OR, semi)
  const beforePipe = afterRunner.split(/\s*[|&;>]\s*/)[0] ?? ""
  return beforePipe.split(/\s+/).filter((t) => t && !t.startsWith("-") && !/^\d+$/.test(t))
}

export function commandFingerprint(cmd: string): string | null {
  const kind = classifyCommand(cmd)
  if (!kind) return null

  // Turbo --filter scoping (applies to any kind: build, test, lint, etc.)
  const turboFilters = extractTurboFilters(cmd)
  if (turboFilters.length > 0) {
    const sorted = orderBy(turboFilters, [(t) => t], ["asc"])
    return `${kind}:${sorted.join(",")}`
  }

  // Nx --projects scoping
  const nxProjects = extractNxProjects(cmd)
  if (nxProjects.length > 0) {
    const sorted = orderBy(nxProjects, [(t) => t], ["asc"])
    return `${kind}:${sorted.join(",")}`
  }

  // Test commands: extract file path scope
  if (kind === "test") {
    const scopeTokens = extractTestScope(cmd)
    const ordered = orderBy(scopeTokens, [(t) => t], ["asc"])
    if (ordered.length > 0) return `${kind}:${ordered.join(",")}`
  }

  return kind
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

function extractShellEvents(cmd: string, lineIdx: number): TranscriptEvent[] {
  const events: TranscriptEvent[] = []
  const kind = classifyCommand(cmd)
  if (kind) {
    events.push({ kind, fingerprint: commandFingerprint(cmd) ?? kind, sourceLineIdx: lineIdx })
  }
  if (kind ? bashMutatesWorkspace(cmd) : bashMutatesWorkspace(cmd)) {
    events.push({ kind: "any_edit", sourceLineIdx: lineIdx })
  }
  return events
}

function extractEventsFromBlock(
  block: Record<string, any>,
  blockedIds: Set<string>,
  lineIdx: number
): TranscriptEvent[] {
  if (block?.type !== "tool_use") return []
  if (blockedIds.has(String(block.id ?? ""))) return []
  const name = String(block.name ?? "")

  if (isShellTool(name)) {
    const inp = block.input as Record<string, any> | undefined
    const cmd = String(inp?.command ?? "").normalize("NFKC")
    return extractShellEvents(cmd, lineIdx)
  }
  if (isCodeChangeTool(name)) {
    return [{ kind: "any_edit", sourceLineIdx: lineIdx }]
  }
  return []
}

function tryParseTranscriptLine(
  line: string
): { type?: string; message?: { content?: unknown } } | null {
  try {
    return JSON.parse(line) as { type?: string; message?: { content?: unknown } }
  } catch {
    return null
  }
}

function extractAssistantContent(entry: unknown): unknown[] | null {
  if (!entry || typeof entry !== "object") return null
  const e = entry as { type?: string; message?: { content?: unknown } }
  if (e.type !== "assistant") return null
  const content = e.message?.content
  return Array.isArray(content) ? content : null
}

export async function parseTranscriptEvents(
  transcriptPath: string,
  cachedSessionLines?: string[]
): Promise<TranscriptEvent[]> {
  const events: TranscriptEvent[] = []
  const lines = cachedSessionLines ?? (await readSessionLines(transcriptPath))
  if (lines.length === 0) return events

  const blockedIds = collectBlockedToolUseIds(lines)

  let lineIdx = 0
  for (const line of lines) {
    if (!line.trim()) {
      lineIdx++
      continue
    }
    const entry = tryParseTranscriptLine(line)
    const content = extractAssistantContent(entry)
    if (content) {
      for (const block of content) {
        events.push(...extractEventsFromBlock(block as Record<string, any>, blockedIds, lineIdx))
      }
    }
    lineIdx++
  }

  return events
}

// ── Remediation: surface errors from the previous same-kind run ───────────────
// Correlates the priorEvent.sourceLineIdx → tool_use_id in the assistant message
// → tool_result text in the subsequent user message. Parsed errors are appended
// to the block message so the agent knows exactly what to edit.

function isMatchingToolUseBlock(block: unknown, kind: CommandKind): boolean {
  const b = block as Record<string, any>
  if (b?.type !== "tool_use") return false
  if (!isShellTool(String(b.name ?? ""))) return false
  const cmd = String((b.input as Record<string, any>)?.command ?? "").normalize("NFKC")
  return classifyCommand(cmd) === kind
}

function findMatchingToolUseId(content: unknown[], kind: CommandKind): string | null {
  for (const block of content) {
    if (isMatchingToolUseBlock(block, kind)) {
      const b = block as Record<string, any>
      return String(b.id ?? "") || null
    }
  }
  return null
}

/** Extract the tool_use id for the first matching-kind bash call in a JSONL line. */
export function extractToolUseIdFromLine(line: string, kind: CommandKind): string | null {
  try {
    const entry = JSON.parse(line)
    if (entry?.type !== "assistant") return null
    const content = entry?.message?.content
    if (!Array.isArray(content)) return null
    return findMatchingToolUseId(content, kind)
  } catch {
    return null
  }
}

async function resolveTranscriptLines(
  transcriptPath: string,
  cachedLines?: string[]
): Promise<string[]> {
  if (cachedLines) return cachedLines.filter((l) => l.trim())
  try {
    const text = await Bun.file(transcriptPath).text()
    return text.split("\n").filter((l) => l.trim())
  } catch {
    return []
  }
}

function extractUserContent(entry: unknown): unknown[] | null {
  if (!entry || typeof entry !== "object") return null
  const e = entry as { type?: string; message?: { content?: unknown } }
  if (e.type !== "user") return null
  const content = e.message?.content
  return Array.isArray(content) ? content : null
}

function findToolResultInBlocks(content: unknown[], toolUseId: string): string | null {
  for (const block of content) {
    if ((block as Record<string, any>)?.tool_use_id === toolUseId) {
      return extractTextFromUnknownContent((block as Record<string, any>).content) || null
    }
  }
  return null
}

function findToolResultText(lines: string[], startIdx: number, toolUseId: string): string {
  for (let i = startIdx; i < lines.length; i++) {
    try {
      const entry = JSON.parse(lines[i]!)
      const content = extractUserContent(entry)
      if (content) {
        const result = findToolResultInBlocks(content, toolUseId)
        if (result) return result
      }
    } catch {}
  }
  return ""
}

/** Read the tool_result text for a given tool_use_id from subsequent transcript lines. */
export async function extractPreviousOutput(
  transcriptPath: string,
  priorSourceLineIdx: number,
  kind: CommandKind,
  cachedLines?: string[]
): Promise<string> {
  const lines = await resolveTranscriptLines(transcriptPath, cachedLines)
  const priorLine = lines[priorSourceLineIdx]
  if (!priorLine) return ""

  const toolUseId = extractToolUseIdFromLine(priorLine, kind)
  if (!toolUseId) return ""

  return findToolResultText(lines, priorSourceLineIdx + 1, toolUseId)
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

// ── Proactive overfiltering detection ─────────────────────────────────────────
// Detects and blocks build/test/lint commands piped through overly restrictive
// filters that discard important output context. Fires on the FIRST run, not
// just on consecutive repeats.

const MIN_TAIL_HEAD_LINES = 10

/** Matches `| tail -N` or `| tail -n N` and captures N. */
const TAIL_LINES_RE = /\|\s*tail\s+(?:-n\s+)?-?(\d+)\b/
/** Matches `| head -N` or `| head -n N` and captures N. */
const HEAD_LINES_RE = /\|\s*head\s+(?:-n\s+)?-?(\d+)\b/
/**
 * Matches `| rg` or `| grep` filtering for only error keywords.
 * Captures the pattern to check if it's overly narrow (just error/fail/ERR).
 */
const GREP_ERROR_ONLY_RE = /\|\s*(?:rg|grep)\s+(?:-[a-zA-Z]+\s+)*["']?([^|;&"']+)["']?/

/** Keywords that indicate a too-narrow grep filter on build/test output. */
const NARROW_GREP_KEYWORDS =
  /^[\s"']*(?:-[a-zA-Z]+\s+)*["']?\s*(?:error|err|fail(?:ed|ure)?|warn(?:ing)?)\s*["']?\s*$/i

/**
 * Detect overly restrictive output filtering on a classified command.
 * Returns a block message if the command pipes through filters that would
 * discard important build/test context, or null if the command is fine.
 */
function checkLineLimitFilter(
  re: RegExp,
  cmd: string,
  direction: string,
  kindLabel: string
): string | null {
  const match = cmd.match(re)
  if (!match) return null
  const n = parseInt(match[1]!, 10)
  if (n >= MIN_TAIL_HEAD_LINES) return null
  return `\`${direction} -${n}\` only shows the ${direction === "tail" ? "last" : "first"} ${n} lines — ${kindLabel} output often needs ${MIN_TAIL_HEAD_LINES}+ lines for meaningful context.`
}

function checkNarrowGrep(cmd: string): string | null {
  const grepMatch = cmd.match(GREP_ERROR_ONLY_RE)
  if (!grepMatch) return null
  const pattern = grepMatch[1]?.trim() ?? ""
  if (!NARROW_GREP_KEYWORDS.test(pattern)) return null
  return `Piping through \`grep/rg\` for only error keywords loses file paths, line numbers, and surrounding context needed to diagnose failures.`
}

export function detectOverfiltering(cmd: string, kind: CommandKind): string | null {
  if (!cmd.includes("|")) return null

  const kindLabel = kind === "test" ? "test" : kind === "build" ? "build" : kind
  const issues = [
    checkLineLimitFilter(TAIL_LINES_RE, cmd, "tail", kindLabel),
    checkLineLimitFilter(HEAD_LINES_RE, cmd, "head", kindLabel),
    checkNarrowGrep(cmd),
  ].filter((x): x is string => x !== null)

  if (issues.length === 0) return null

  const unfiltered = cmd.replace(/\s*\|.*$/, "").trim()
  return [
    `**Overly restrictive output filtering on \`${kindLabel}\` command.**`,
    issues.join("\n"),
    formatActionPlan([
      `Run without filters: \`${unfiltered}\``,
      `If output is too long, use \`| tail -${MIN_TAIL_HEAD_LINES}\` or higher (minimum ${MIN_TAIL_HEAD_LINES} lines).`,
      "Read the full output first, then filter if needed on a subsequent diagnostic pass.",
    ]),
  ].join("\n\n")
}

// ── Main ─────────────────────────────────────────────────────────────────────

interface PriorEventMatch {
  priorEvent: TranscriptEvent
  currentKind: CommandKind
}

function findConsecutiveRepeat(
  events: TranscriptEvent[],
  command: string,
  currentKind: CommandKind
): PriorEventMatch | null {
  const sameKindEvents = events.filter((e) => e.kind === currentKind)
  if (sameKindEvents.length < 2) return null

  const currentEvent = sameKindEvents[sameKindEvents.length - 1]!
  const priorEvent = sameKindEvents[sameKindEvents.length - 2]!

  // Parallel dispatch guard
  if (priorEvent.sourceLineIdx === currentEvent.sourceLineIdx) return null

  // Scope-fingerprint guard
  const currentFp = commandFingerprint(command) ?? currentKind
  if (priorEvent.fingerprint && priorEvent.fingerprint !== currentFp) return null

  // Intervening work guard
  const lastPriorRunIdx = events.indexOf(priorEvent)
  const hasInterveningWork = events.slice(lastPriorRunIdx + 1).some((e) => e.kind === "any_edit")
  if (hasInterveningWork) return null

  return { priorEvent, currentKind }
}

async function buildBlockMessage(
  command: string,
  match: PriorEventMatch,
  transcriptPath: string,
  cachedSessionLines?: string[]
): Promise<string> {
  const label = commandLabel(command, match.currentKind)
  const firstLine = command.split("\n")[0]?.trim().slice(0, 80) ?? command.trim()

  const prevOutput = await extractPreviousOutput(
    transcriptPath,
    match.priorEvent.sourceLineIdx,
    match.currentKind,
    cachedSessionLines
  )
  const remediationHints = buildRemediationHints(prevOutput, match.currentKind)
  const readStep = buildReadOutputStep(
    label,
    transcriptPath,
    match.priorEvent.sourceLineIdx,
    prevOutput
  )

  return [
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
}

function resolveCommandAndKind(input: {
  tool_name?: string
  tool_input?: unknown
}): { command: string; currentKind: CommandKind } | null {
  const toolName = input.tool_name ?? ""
  if (!isShellTool(toolName)) return null

  const command = String((input.tool_input as Record<string, any>)?.command ?? "").normalize("NFKC")

  const currentKind = classifyCommand(command)
  if (!currentKind) return null
  if (isHelpQuery(command)) return null

  return { command, currentKind }
}

export async function evaluatePretooluseRepeatedLintTest(input: unknown): Promise<SwizHookOutput> {
  const hookInput = toolHookInputSchema.parse(input)
  const cwd = hookInput.cwd ?? process.cwd()
  const transcriptPath = hookInput.transcript_path ?? ""

  const parsed = resolveCommandAndKind(hookInput)
  if (!parsed) return {}

  const { command, currentKind } = parsed

  const overfilterIssue = detectOverfiltering(command, currentKind)
  if (overfilterIssue) return preToolUseDeny(overfilterIssue)

  if (!(await isGitRepo(cwd))) return {}
  if (!transcriptPath) return {}

  const cachedSessionLines = getTranscriptSummary(
    hookInput as unknown as Record<string, any>
  )?.sessionLines

  const events = await parseTranscriptEvents(transcriptPath, cachedSessionLines)
  const match = findConsecutiveRepeat(events, command, currentKind)
  if (!match) return {}

  const blockMessage = await buildBlockMessage(command, match, transcriptPath, cachedSessionLines)
  return preToolUseDeny(blockMessage)
}

const pretooluseRepeatedLintTest: SwizToolHook = {
  name: "pretooluse-repeated-lint-test",
  event: "preToolUse",
  timeout: 5,
  cooldownSeconds: 120,
  run(input) {
    return evaluatePretooluseRepeatedLintTest(input)
  },
}

export default pretooluseRepeatedLintTest

if (import.meta.main) {
  await runSwizHookAsMain(pretooluseRepeatedLintTest)
}
