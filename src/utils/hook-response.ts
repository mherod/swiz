// Hook response / output-helper cluster, extracted from hook-utils.ts (issue #677).
// Outputs polyglot JSON understood by Claude Code, Cursor, Gemini CLI, and Codex CLI.
// hook-utils.ts re-exports this module so the ~183 existing importers stay unchanged.

import { rephraseHookMessage } from "../hook-message-rephrasing.ts"
import { isInlineSwizHookRun, SwizHookExit } from "../inline-hook-context.ts"
import { buildContextHookOutput } from "../SwizHook.ts"
import { type HookOutput, hookOutputSchema } from "../schemas.ts"
import { extractHookSystemMessagePreview } from "./hook-json-helpers.ts"
import { sanitizeHookOutputForCurrentAgent } from "./hook-output-agent-compat.ts"
import {
  hsoPostToolUseDenyBlock,
  hsoPreToolUseAllow,
  hsoPreToolUseAllowContextual,
  hsoPreToolUseAllowWithUpdatedInput,
  hsoPreToolUseDeny,
} from "./hook-specific-output.ts"

/**
 * Stop / PostToolUse block: `systemMessage` is a first-line preview; full text stays in `reason`.
 * Cursor and other UIs surface `systemMessage` prominently — 70 chars looked like junk truncation.
 */
const PREVIEW_LEN_BLOCK = 4000

function denyPreToolUseObj(reason: string) {
  const fullReason = `${reason}\n\nYou must act on this now. Do not try to stop again without completing the required action.`
  return hookOutputSchema.parse({
    suppressOutput: true,
    systemMessage: extractHookSystemMessagePreview(reason),
    hookSpecificOutput: hsoPreToolUseDeny(fullReason),
  })
}

/** Emit a PreToolUse denial and exit. Works across all agents. */
export function denyPreToolUse(reason: string): never {
  exitWithHookObject(denyPreToolUseObj(reason))
}

function allowPreToolUseObj(reason: string): HookOutput {
  const rephrasedReason = reason ? rephraseHookMessage(reason) : reason
  return hookOutputSchema.parse({
    suppressOutput: true,
    systemMessage: extractHookSystemMessagePreview(rephrasedReason),
    hookSpecificOutput: hsoPreToolUseAllow(rephrasedReason),
  })
}

/** Emit a PreToolUse allow with advisory context and exit. Does NOT block. Works across all agents. */
export function allowPreToolUse(reason: string): never {
  exitWithHookObject(allowPreToolUseObj(reason))
}

function allowPreToolUseWithContextObj(
  additionalContext: string,
  effectiveReason: string
): HookOutput {
  return hookOutputSchema.parse({
    suppressOutput: true,
    ...(additionalContext && { systemMessage: additionalContext }),
    hookSpecificOutput: hsoPreToolUseAllowContextual(
      effectiveReason || undefined,
      additionalContext || undefined
    ),
  })
}

/** Emit a PreToolUse allow with both a visible hint and additionalContext. */
export function allowPreToolUseWithContext(reason: string, additionalContext: string): never {
  const rephrasedReason = reason ? rephraseHookMessage(reason) : ""
  const rephrasedContext = additionalContext ? rephraseHookMessage(additionalContext) : ""
  const effectiveReason = rephrasedReason || rephrasedContext
  exitWithHookObject(allowPreToolUseWithContextObj(rephrasedContext, effectiveReason))
}

function allowPreToolUseWithUpdatedInputObj(
  updatedInput: Record<string, any>,
  reason?: string
): HookOutput {
  return hookOutputSchema.parse({
    suppressOutput: true,
    systemMessage: extractHookSystemMessagePreview(reason ?? ""),
    hookSpecificOutput: hsoPreToolUseAllowWithUpdatedInput(updatedInput, reason),
  })
}

/** Emit a PreToolUse allow with modified tool input and exit. Works across all agents. */
export function allowPreToolUseWithUpdatedInput(
  updatedInput: Record<string, any>,
  reason?: string
): never {
  exitWithHookObject(allowPreToolUseWithUpdatedInputObj(updatedInput, reason))
}

/**
 * Factory for file-path guard PreToolUse hooks.
 *
 * Returns an async `main()` that parses stdin, tests the file path against
 * `predicate`, and calls `denyPreToolUse` / `allowPreToolUse` accordingly.
 * Absorbs the boilerplate shared by lockfile, node_modules, and similar guards.
 */
export function filePathGuardHook(
  predicate: (filePath: string) => boolean,
  denyReason: string,
  allowMsg?: string | ((filePath: string) => string)
): () => Promise<void> {
  return async (): Promise<void> => {
    // Load input schema dynamically to avoid circular dependencies
    const { fileEditHookInputSchema } = await import("../schemas.ts")
    const input = fileEditHookInputSchema.parse(await Bun.stdin.json())
    const filePath = input.tool_input?.file_path ?? ""

    // If the file matches the deny predicate, block immediately
    if (predicate(filePath)) {
      denyPreToolUse(denyReason)
    }

    // Resolve the allow message (function -> result, string -> direct, undefined -> empty)
    const message = typeof allowMsg === "function" ? allowMsg(filePath) : (allowMsg ?? "")
    allowPreToolUse(message)
  }
}

/** PostToolUse block payload without stdout/exit — use from `SwizHook.run()`. */
export function buildDenyPostToolUseOutput(reason: string): HookOutput {
  return hookOutputSchema.parse({
    decision: "block",
    reason,
    suppressOutput: true,
    systemMessage: extractHookSystemMessagePreview(reason, PREVIEW_LEN_BLOCK),
    hookSpecificOutput: hsoPostToolUseDenyBlock(reason),
  })
}

export function exitWithHookObject(obj: HookOutput): never {
  const safeObj = sanitizeHookOutputForCurrentAgent(obj)
  if (isInlineSwizHookRun()) {
    throw new SwizHookExit(safeObj)
  }
  process.stdout.write(`${JSON.stringify(safeObj)}\n`)
  process.exit(0)
}

/** Emit a PostToolUse block decision and exit. Works across all agents. */
export function denyPostToolUse(reason: string): never {
  exitWithHookObject(buildDenyPostToolUseOutput(reason))
}

/**
 * Emit additional context for a hook event. **Subprocess-only:** calls `process.exit(0)`.
 * From `SwizHook.run()` (inline dispatch), return {@link buildContextHookOutput} instead
 * so the dispatcher can record cooldowns and merge results with other hooks.
 */
export function emitContext(eventName: string, context: string): never {
  exitWithHookObject(buildContextHookOutput(eventName, context))
}

export function blockStopObj(reason: string): HookOutput {
  const preview = extractHookSystemMessagePreview(reason, PREVIEW_LEN_BLOCK)
  // Omit hookSpecificOutput: Claude Code only allows hookSpecificOutput for PreToolUse,
  // UserPromptSubmit, and PostToolUse — hookEventName "Stop" fails JSON validation.
  return hookOutputSchema.parse({
    decision: "block",
    continue: true,
    reason:
      reason +
      `\n\nYou must act on this now. Do not try to stop again without completing the required action.`,
    suppressOutput: true,
    systemMessage: preview,
  })
}

/** Emit a stop block decision and exit. Appends ACTION_REQUIRED footer. */
export function blockStop(reason: string): never {
  exitWithHookObject(blockStopObj(reason))
}

function blockStopRawObj(reason: string) {
  const preview = extractHookSystemMessagePreview(reason, PREVIEW_LEN_BLOCK)
  return hookOutputSchema.parse({
    decision: "block",
    continue: true,
    reason,
    suppressOutput: true,
    systemMessage: preview,
  })
}

/** Emit a raw stop block (no footer appended — caller controls the full reason). */
export function blockStopRaw(reason: string): never {
  exitWithHookObject(blockStopRawObj(reason))
}

/** Inline SwizHook equivalent of {@link blockStopHumanRequired}. */
export function blockStopHumanRequiredObj(reason: string): HookOutput {
  const fullReason = `${reason}\n\nResolve this block before stopping.`
  const preview = extractHookSystemMessagePreview(reason, PREVIEW_LEN_BLOCK)
  return hookOutputSchema.parse({
    decision: "block",
    continue: true,
    reason: fullReason,
    resolution: "human-required",
    suppressOutput: true,
    systemMessage: preview,
  })
}

/**
 * Emit a stop block that requires human action to resolve.
 * Adds `resolution: "human-required"` to the output so the agent understands
 * it cannot resolve the block autonomously — a human must intervene.
 * Appends a note to the reason explaining this.
 */
export function blockStopHumanRequired(reason: string): never {
  exitWithHookObject(blockStopHumanRequiredObj(reason))
}
