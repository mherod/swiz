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

import {
  collectBlockedToolUseIds,
  denyPreToolUse,
  formatActionPlan,
  isCodeChangeTool,
  isGitRepo,
  isShellTool,
  stripAnsi,
} from "./hook-utils.ts"
import { toolHookInputSchema } from "./schemas.ts"

// ── Command kind classification ───────────────────────────────────────────────

type CommandKind = "test" | "lint" | "typecheck" | "check" | "build"

const TEST_RE = /(?:^|[|;&]|\|\|)\s*bun\s+test\b/
const LINT_RE = /(?:^|[|;&]|\|\|)\s*bun\s+run\s+lint\b/
const TYPECHECK_RE = /(?:^|[|;&]|\|\|)\s*bun\s+run\s+typecheck\b/
const CHECK_RE = /(?:^|[|;&]|\|\|)\s*bun\s+run\s+check\b/
const BUILD_RE = /(?:^|[|;&]|\|\|)\s*bun\s+run\s+build\b/

export function classifyCommand(cmd: string): CommandKind | null {
  if (TEST_RE.test(cmd)) return "test"
  if (LINT_RE.test(cmd)) return "lint"
  if (TYPECHECK_RE.test(cmd)) return "typecheck"
  if (CHECK_RE.test(cmd)) return "check"
  if (BUILD_RE.test(cmd)) return "build"
  return null
}

const COMMAND_LABEL: Record<CommandKind, string> = {
  test: "bun test",
  lint: "bun run lint",
  typecheck: "bun run typecheck",
  check: "bun run check",
  build: "bun run build",
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

export function bashMutatesWorkspace(cmd: string): boolean {
  // Plain output redirect: "> file" or ">> file"
  // (?<![0-9&]) excludes 2>&1-style FD redirects but also misses &> and N>.
  // Those are handled by the two checks below.
  // IMPORTANT: exclusion lookaheads embed \s* internally so the engine cannot
  // backtrack the outer \s* to 0 and bypass the /dev/ exclusion. Without this,
  // "> /dev/null" falsely matches because \s* retracts to 0, leaving the engine
  // at the space character where (?!\/dev\/) incorrectly passes.
  if (/(?<![0-9&])>>?(?!\s*\/dev\/)(?!\s*[&])/.test(cmd)) return true
  // &> and &>> — bash shorthand for redirecting both stdout and stderr to a file
  if (/&>>?(?!\s*\/dev\/)(?!\s*[&>])/.test(cmd)) return true
  // N> and N>> numbered FD-to-file redirects (e.g. 1> file, 2> file)
  // Excludes FD-to-FD (2>&1) via (?!\s*[&>])
  if (/\d>>?(?!\s*\/dev\/)(?!\s*[&>])/.test(cmd)) return true
  // tee to a named destination (not /dev/null or /dev/stderr)
  if (/\btee\s+(?!\/dev\/)/.test(cmd)) return true
  // In-place sed: -i (any position in combined flags, e.g. -i, -iE, -Ei, -ni),
  //   -i.bak (backup suffix), and GNU long form --in-place / --in-place=.bak
  if (/\bsed\b(?:[^|;]*\s+-[a-zA-Z]*i[a-zA-Z.]*|[^|;]*--in-place)/.test(cmd)) return true
  // In-place perl: -i (any position in combined flags, e.g. -i, -pi, -pie, -i.bak)
  //   perl has no --in-place long form; -i is the only spelling
  if (/\bperl\b[^|;]*\s+-[a-zA-Z]*i[a-zA-Z.]*/.test(cmd)) return true
  // In-place ruby: -i (same semantics as perl/sed, e.g. -i, -ri, -i.bak)
  if (/\bruby\b[^|;]*\s+-[a-zA-Z]*i[a-zA-Z.]*/.test(cmd)) return true
  // GNU awk in-place: awk/gawk -i inplace (two-token form — inplace is a library name)
  if (/\b(?:g?awk)\b[^|;]*-i\s+inplace/.test(cmd)) return true
  // patch: always mutates workspace files (applies unified diffs to source files)
  if (/\bpatch\b\s+/.test(cmd)) return true
  // Python -c inline script with write-mode open(): open(..., 'w'/'a'/'x'/variants)
  //   Covers: open('f','w'), open('f','wb'), open('f','ab'), open('f','xb'), etc.
  if (/\bpython\d*\b[^|;]*-c\b.*\bopen\s*\([^)]*['"][wax][bt]?['"]/.test(cmd)) return true
  // Python -c inline script with pathlib filesystem methods:
  //   write_text/write_bytes (content writes), unlink/rename/replace (deletions/moves),
  //   rmdir/mkdir/touch (directory and metadata mutations)
  if (
    /\bpython\d*\b[^|;]*-c\b.*\.(?:write(?:_text|_bytes)?|unlink|rename|replace|rmdir|mkdir|touch)\s*\(/.test(
      cmd
    )
  )
    return true
  // Python -c inline script with os filesystem mutations (remove, unlink, rename, mkdir…)
  if (
    /\bpython\d*\b[^|;]*-c\b.*\bos\.(?:remove|unlink|rename|replace|makedirs|mkdir|rmdir)\s*\(/.test(
      cmd
    )
  )
    return true
  // Python -c inline script with shutil mutations (copy, move, rmtree)
  if (/\bpython\d*\b[^|;]*-c\b.*\bshutil\.(?:copy2?|move|rmtree)\s*\(/.test(cmd)) return true
  // Python -m with in-place formatters that always mutate files (no flag required)
  if (/\bpython\d*\b[^|;]*-m\s+(?:black|isort|autopep8)\b/.test(cmd)) return true
  // Python -m 2to3 -w: explicit write-in-place flag
  if (/\bpython\d*\b[^|;]*-m\s+2to3\b[^|;]*-w\b/.test(cmd)) return true
  // Common CLI output flags — space-separated: -o path, --output path, --outfile path
  if (/(?:^|\s)(?:-o|--(?:out(?:put|file|dir)?|report|log-?file))\s+\S/.test(cmd)) return true
  // Common CLI output flags — equals-separated: --output=path, --outfile=path
  if (/--(?:out(?:put|file|dir)?|report|log-?file)=\S/.test(cmd)) return true
  // File deletions: rm, trash, unlink
  if (/\b(?:rm|trash|unlink)\s+/.test(cmd)) return true
  // File moves and copies (structural workspace changes)
  if (/\b(?:mv|cp)\s+/.test(cmd)) return true
  // Directory creation/deletion
  if (/\b(?:mkdir|rmdir)\b/.test(cmd)) return true
  // Environment variable-driven workspace mutations:
  // Inline KEY=./relative-path assignments mean the command writes output to a
  // workspace-local location specified by the env var.
  // ./prefix distinguishes workspace-relative paths from system/absolute paths.
  if (/\b[A-Z_]+=\.\//i.test(cmd)) return true
  return false
}

// ── Transcript event types ───────────────────────────────────────────────────

export type EventKind = CommandKind | "any_edit"

export interface TranscriptEvent {
  kind: EventKind
  /** JSONL source line index. Two events with the same index are from the
   *  same assistant message (parallel dispatch) and neither has been executed
   *  yet — they cannot be treated as a prior/current pair. */
  sourceLineIdx: number
}

export async function parseTranscriptEvents(transcriptPath: string): Promise<TranscriptEvent[]> {
  const events: TranscriptEvent[] = []
  let text = ""
  try {
    text = await Bun.file(transcriptPath).text()
  } catch {
    return events
  }

  const lines = text.split("\n")
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
            events.push({ kind, sourceLineIdx: lineIdx })
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
  kind: CommandKind
): Promise<string> {
  let text = ""
  try {
    text = await Bun.file(transcriptPath).text()
  } catch {
    return ""
  }

  const lines = text.split("\n").filter((l) => l.trim())
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
        const inner: unknown = block.content
        if (typeof inner === "string") return inner
        if (Array.isArray(inner)) {
          return (inner as Array<{ type?: string; text?: string }>)
            .filter((b) => b?.type === "text")
            .map((b) => b.text ?? "")
            .join("\n")
        }
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

  if (!(await isGitRepo(cwd))) return
  if (!transcriptPath) return

  const events = await parseTranscriptEvents(transcriptPath)

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

  const lastPriorRunIdx = events.indexOf(priorEvent)

  // Check if any Edit/Write/Notebook happened between the prior run and current.
  // If so, the agent was acting on the output (real work) — allow the repeat.
  const hasInterveningWork = events.slice(lastPriorRunIdx + 1).some((e) => e.kind === "any_edit")

  if (hasInterveningWork) return

  // Block: consecutive repeat of the same command kind with no intervening work.
  const label = COMMAND_LABEL[currentKind]
  const firstLine = command.split("\n")[0]?.trim().slice(0, 80) ?? command.trim()

  // Extract specific errors from the previous run to guide remediation.
  const prevOutput = await extractPreviousOutput(
    transcriptPath,
    priorEvent.sourceLineIdx,
    currentKind
  )
  const remediationHints = buildRemediationHints(prevOutput, currentKind)

  denyPreToolUse(
    `**Consecutive ${label} blocked.**\n\n` +
      `You ran \`${label}\` and immediately tried to run it again without editing any files in between. ` +
      `This is the over-filtering pattern — re-running with different grep/tail flags instead of reading the full output.\n\n` +
      formatActionPlan([
        `Read the full output from the previous ${label} run.`,
        "Edit any file to signal you acted on the output, or update CLAUDE.md with a DO/DON'T rule.",
        `Then re-run without filters: \`${firstLine.replace(/\s*\|.*$/, "").trim()}\``,
      ]) +
      remediationHints +
      `\nThis gate clears once you edit any file — signalling you acted on the output rather than blindly retrying.`
  )
}

if (import.meta.main) await main()
