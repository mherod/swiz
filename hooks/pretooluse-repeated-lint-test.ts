#!/usr/bin/env bun
// PreToolUse hook: Block consecutive repeated lint/test/build commands of the
// same type (test, lint, or build) when no Edit/Write work occurred between
// them. Prevents the wasteful pattern of re-running the same command with
// different output filters instead of reading the full output.
//
// "Uninterrupted" means: no Edit or Write tool call between the previous
// same-type run and the current one. If the agent edited files in between,
// they were acting on the output — that's normal and is allowed.
//
// When blocked, the agent must update memory (CLAUDE.md or MEMORY.md) with
// what the previous run showed, then re-run without filters.

import {
  denyPreToolUse,
  formatActionPlan,
  isEditTool,
  isGitRepo,
  isShellTool,
  isWriteTool,
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

// ── Transcript event types ───────────────────────────────────────────────────

type EventKind = CommandKind | "any_edit"

interface TranscriptEvent {
  kind: EventKind
}

async function parseTranscriptEvents(transcriptPath: string): Promise<TranscriptEvent[]> {
  const events: TranscriptEvent[] = []
  let text = ""
  try {
    text = await Bun.file(transcriptPath).text()
  } catch {
    return events
  }

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
          if (kind) events.push({ kind })
        } else if (isEditTool(name) || isWriteTool(name)) {
          // Any file edit counts as "intervening work" — even to non-memory files.
          // If the agent wrote code between two test runs, that's a real re-run.
          // Capture even when extractFilePath is empty (Write with content= field).
          events.push({ kind: "any_edit" })
        }
      }
    } catch {
      // Ignore malformed lines
    }
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
  const sameKindIndices: number[] = []
  for (let i = 0; i < events.length; i++) {
    if (events[i]!.kind === currentKind) sameKindIndices.push(i)
  }

  // Need at least 2 occurrences: one prior call + the current call (last in transcript)
  if (sameKindIndices.length < 2) return

  const lastPriorRunIdx = sameKindIndices[sameKindIndices.length - 2]!

  // Check if any Edit/Write happened between the prior run and the current call.
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
        "Edit CLAUDE.md or memory/MEMORY.md with a DO/DON'T rule about what you found.",
        `Then re-run without filters: \`${firstLine.replace(/\s*\|.*$/, "").trim()}\``,
      ]) +
      `\nThis gate clears once you edit any file — signalling you acted on the output rather than blindly retrying.`
  )
}

await main()
