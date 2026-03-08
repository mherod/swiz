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
  denyPreToolUse,
  formatActionPlan,
  isCodeChangeTool,
  isGitRepo,
  isShellTool,
} from "./hook-utils.ts"
import { toolHookInputSchema } from "./schemas.ts"

// ── Command kind classification ───────────────────────────────────────────────

type CommandKind = "test" | "lint" | "build"

const TEST_RE = /(?:^|[|;&]|\|\|)\s*bun\s+test\b/
const LINT_RE = /(?:^|[|;&]|\|\|)\s*bun\s+run\s+(?:lint|typecheck|check)\b/
const BUILD_RE = /(?:^|[|;&]|\|\|)\s*bun\s+run\s+build\b/

function classifyCommand(cmd: string): CommandKind | null {
  if (TEST_RE.test(cmd)) return "test"
  if (LINT_RE.test(cmd)) return "lint"
  if (BUILD_RE.test(cmd)) return "build"
  return null
}

const COMMAND_LABEL: Record<CommandKind, string> = {
  test: "bun test",
  lint: "bun run lint / typecheck / check",
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

function bashMutatesWorkspace(cmd: string): boolean {
  // Plain output redirect: "> file" or ">> file"
  // (?<![0-9&]) excludes 2>&1-style FD redirects but also misses &> and N>.
  // Those are handled by the two checks below.
  if (/(?<![0-9&])>>?\s*(?![&])(?!\/dev\/)/.test(cmd)) return true
  // &> and &>> — bash shorthand for redirecting both stdout and stderr to a file
  if (/&>>?\s*(?![&>])(?!\/dev\/)/.test(cmd)) return true
  // N> and N>> numbered FD-to-file redirects (e.g. 1> file, 2> file)
  // Excludes FD-to-FD (2>&1) via (?![&>])
  if (/\d>>?\s*(?![&>])(?!\/dev\/)/.test(cmd)) return true
  // tee to a named destination (not /dev/null or /dev/stderr)
  if (/\btee\s+(?!\/dev\/)/.test(cmd)) return true
  // In-place sed: -i (any position in combined flags, e.g. -i, -iE, -Ei, -ni),
  //   -i.bak (backup suffix), and GNU long form --in-place / --in-place=.bak
  if (/\bsed\b(?:[^|;]*\s+-[a-zA-Z]*i[a-zA-Z.]*|[^|;]*--in-place)/.test(cmd)) return true
  // In-place perl: -i (any position in combined flags, e.g. -i, -pi, -pie, -i.bak)
  //   perl has no --in-place long form; -i is the only spelling
  if (/\bperl\b[^|;]*\s+-[a-zA-Z]*i[a-zA-Z.]*/.test(cmd)) return true
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

type EventKind = CommandKind | "any_edit"

interface TranscriptEvent {
  kind: EventKind
  /** JSONL source line index. Two events with the same index are from the
   *  same assistant message (parallel dispatch) and neither has been executed
   *  yet — they cannot be treated as a prior/current pair. */
  sourceLineIdx: number
}

async function parseTranscriptEvents(transcriptPath: string): Promise<TranscriptEvent[]> {
  const events: TranscriptEvent[] = []
  let text = ""
  try {
    text = await Bun.file(transcriptPath).text()
  } catch {
    return events
  }

  let lineIdx = 0
  for (const line of text.split("\n")) {
    if (!line.trim()) continue
    try {
      const entry = JSON.parse(line)
      if (entry?.type !== "assistant") continue
      const content = entry?.message?.content
      if (!Array.isArray(content)) continue

      for (const block of content) {
        if (block?.type !== "tool_use") continue
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

  denyPreToolUse(
    `**Consecutive ${label} blocked.**\n\n` +
      `You ran \`${label}\` and immediately tried to run it again without editing any files in between. ` +
      `This is the over-filtering pattern — re-running with different grep/tail flags instead of reading the full output.\n\n` +
      formatActionPlan([
        `Read the full output from the previous ${label} run.`,
        "Edit any file to signal you acted on the output, or update CLAUDE.md with a DO/DON'T rule.",
        `Then re-run without filters: \`${firstLine.replace(/\s*\|.*$/, "").trim()}\``,
      ]) +
      `\nThis gate clears once you edit any file — signalling you acted on the output rather than blindly retrying.`
  )
}

await main()
