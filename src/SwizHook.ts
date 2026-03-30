/**
 * SwizHook — self-describing inline hook interface.
 *
 * A SwizHook is a self-contained hook object that carries its own dispatch
 * metadata (event, matcher, timeout, cooldown, requiredSettings) alongside a
 * typed run() function. Hooks defined this way can be registered directly in
 * the manifest and executed in-process — no subprocess spawn required.
 *
 * **No `process.exit` in `run()`:** return `preToolUseAllow` / `preToolUseDeny`,
 * `buildContextHookOutput`, etc. Subprocess-only helpers (`denyPreToolUse`,
 * `emitContext`, …) redirect via `SwizHookExit` during inline dispatch — prefer
 * explicit returns.
 *
 * ## Migration path
 * Existing file-based hooks continue to work unchanged via `FileHookDef`. New
 * hooks can adopt this format by implementing `SwizHook<TInput>` and registering
 * as `{ hook: instance }` in the manifest. The dispatcher executes both formats
 * using the same strategy pipeline.
 *
 * ## Event-specific aliases
 * Use the narrowed aliases (SwizFileEditHook, SwizShellHook, etc.) to get typed
 * run() inputs without manually specifying the generic parameter.
 */

import {
  type FileEditHookInput,
  type HookOutput,
  hookOutputSchema,
  type SessionHookInput,
  type ShellHookInput,
  type StopHookInput,
  type ToolHookInput,
} from "../hooks/schemas.ts"
import type { EffectiveSwizSettings } from "./settings"

// ─── Standalone runner ──────────────────────────────────────────────────────

/** Options for `runSwizHookAsMain`. */
export interface RunSwizHookAsMainOptions {
  /**
   * Called when stdin JSON parsing fails. Return a fallback output object
   * to emit instead of crashing (e.g. a block-stop response).
   * When omitted, the process exits with code 1.
   */
  onStdinJsonError?: (err: unknown) => SwizHookOutput
}

/**
 * Run a SwizHook as a standalone main script (file-based dispatch / manual testing).
 *
 * Reads JSON from stdin, injects `_effectiveSettings` if absent (the dispatcher
 * injects it for inline hooks, but subprocess invocations don't have it), calls
 * `hook.run()`, and writes any non-empty output to stdout.
 *
 * Usage in a hook file:
 * ```ts
 * if (import.meta.main) await runSwizHookAsMain(myHook)
 * ```
 */
export async function runSwizHookAsMain(
  hook: SwizHook<Record<string, unknown>>,
  options?: RunSwizHookAsMainOptions
): Promise<void> {
  let input: Record<string, unknown>
  try {
    const parsed = (await Bun.stdin.json()) as unknown
    if (!parsed || typeof parsed !== "object") process.exit(0)
    input = parsed as Record<string, unknown>
  } catch (err) {
    if (options?.onStdinJsonError) {
      const fallback = options.onStdinJsonError(err)
      if (fallback && Object.keys(fallback).length > 0) {
        const { exitWithHookObject } = await import("./utils/hook-utils.ts")
        exitWithHookObject(fallback)
      }
      process.exit(0)
    }
    process.stderr.write(`Hook error: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  }

  // Inject effective settings when missing (subprocess path).
  // Wrapped in try/catch — hooks that don't use settings still work if the
  // import chain has issues (e.g. circular dependencies in standalone mode).
  if (!input._effectiveSettings) {
    try {
      const { getEffectiveSwizSettings, readSwizSettings } = await import("./settings.ts")
      const sessionId = typeof input.session_id === "string" ? input.session_id : null
      const rawSettings = await readSwizSettings()
      input._effectiveSettings = getEffectiveSwizSettings(
        rawSettings,
        sessionId
      ) as unknown as Record<string, unknown>
    } catch {
      // Settings injection is best-effort; hooks that need settings will
      // check for their presence and exit early if missing.
    }
  }

  const output = await hook.run(input)
  if (output && Object.keys(output).length > 0) {
    const { exitWithHookObject } = await import("./utils/hook-utils.ts")
    exitWithHookObject(output)
  }
}

// ─── Output type ─────────────────────────────────────────────────────────────

/**
 * The return type of a hook's run() function.
 * Mirrors the JSON object that file-based hooks write to stdout.
 * An empty object (`{}`) is equivalent to "no output" — allow with no hint.
 */

// biome-ignore lint/complexity/noBannedTypes: Allow empty object
export type SwizHookOutput = HookOutput | {}

/**
 * Build additionalContext / systemMessage payload for SessionStart, UserPromptSubmit,
 * PostToolUse, etc. Safe for manifest-linked inline hooks (no hook-utils import).
 */
export function buildContextHookOutput(eventName: string, context: string): SwizHookOutput {
  return hookOutputSchema.parse({
    systemMessage: context,
    suppressOutput: true,
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext: context,
    },
  })
}

// ─── PreToolUse output builders ─────────────────────────────────────────────
// Inline equivalents of the process.exit-based helpers in hook-utils.ts.
// These return output objects instead of terminating the process, making them
// safe for use in SwizHook.run() implementations.

/** Build a PreToolUse allow response (mirrors `allowPreToolUse`). */
export function preToolUseAllow(reason = ""): SwizHookOutput {
  const firstLine = reason.slice(0, 70).split("\n").shift()
  return {
    suppressOutput: true,
    systemMessage: firstLine || "",
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow" as const,
      permissionDecisionReason: reason,
    },
  }
}

const PRE_TOOL_ACTION_REQUIRED =
  "\n\nACTION REQUIRED: Fix the underlying issue before retrying. Do not attempt to bypass or work around it — address the root cause."

/** Build a PreToolUse deny response (mirrors `denyPreToolUse`). Appends ACTION REQUIRED footer. */
export function preToolUseDeny(reason: string): SwizHookOutput {
  const firstLine = reason.slice(0, 70).split("\n").shift()
  const fullReason = reason + PRE_TOOL_ACTION_REQUIRED
  return {
    suppressOutput: true,
    systemMessage: firstLine || "Denied without reason",
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny" as const,
      permissionDecisionReason: fullReason,
    },
  }
}

// ─── Metadata ────────────────────────────────────────────────────────────────

/**
 * Dispatch metadata carried by every SwizHook instance.
 * These fields mirror the optional fields on `FileHookDef` so the dispatcher
 * treats both formats identically.
 */
export interface SwizHookMeta {
  /** Unique identifier used for logging and cooldown keying. */
  name: string
  /**
   * Canonical event this hook subscribes to.
   * Must match one of the events in the manifest (e.g. "preToolUse", "stop").
   */
  event: string
  /**
   * Optional pipe-delimited tool matcher (e.g. "Bash" or "Edit|Write").
   * When set, the hook only runs when the tool name matches.
   */
  matcher?: string
  /** Maximum seconds before the dispatcher considers this hook timed out. */
  timeout?: number
  /**
   * When true, the hook may run outside the synchronous fan-out (see `asyncMode`).
   * Has no effect unless the dispatcher treats the event as supporting async hooks.
   */
  async?: boolean
  /**
   * How the dispatcher schedules hooks with `async: true`.
   * - `"fire-and-forget"` (default): started alongside sync hooks; not awaited in CLI.
   *   In daemon context, file hooks run on the worker pool and are awaited before the
   *   dispatch completes; inline hooks are still awaited only when `daemonContext` is set.
   * - `"block-until-complete"`: runs in the sync hook pipeline and is fully awaited; output
   *   merges like a non-async hook (deny/block/context apply normally).
   */
  asyncMode?: "fire-and-forget" | "block-until-complete"
  /**
   * Minimum seconds between successive runs (scoped per hook name + cwd).
   * Behaviour controlled by `cooldownMode`.
   */
  cooldownSeconds?: number
  /**
   * Controls when the cooldown timer activates after a hook run.
   * - `"block-only"` (default): cooldown only activates on deny/block.
   * - `"always"`: cooldown activates after every run regardless of result.
   */
  cooldownMode?: "block-only" | "always"
  /**
   * Optional environment-based skip condition (e.g. `"env:CI!=true"`).
   * Evaluated before run(); falsy conditions skip the hook entirely.
   */
  condition?: string
  /**
   * When set, hook only runs when the project matches at least one listed stack.
   * Supported: "bun", "node", "go", "python", "ruby", "rust", "java", "php"
   */
  stacks?: string[]
  /**
   * Settings keys that must all be truthy for this hook to run.
   * Evaluated by the dispatcher before calling run() — zero-cost fast path.
   */
  requiredSettings?: (keyof EffectiveSwizSettings)[]
  /**
   * When true, this hook is a non-agent/scheduled event (e.g. preCommit, prPoll).
   * Skips agent eventMap validation and `swiz install`.
   */
  scheduled?: boolean
}

// ─── Core interface ───────────────────────────────────────────────────────────

/**
 * A SwizHook bundles dispatch metadata with a typed run() implementation.
 *
 * @template TInput - The expected input type for run(). Defaults to the generic
 *   ToolHookInput envelope. Use event-specific aliases for narrower types.
 */
export interface SwizHook<TInput = ToolHookInput> extends SwizHookMeta {
  /**
   * Execute the hook logic.
   *
   * @param input - Parsed hook payload from stdin.
   * @returns A HookOutput object (or Promise thereof). Return `{}` to pass
   *   without a hint. Use `preToolUseDeny` / blocking shapes for denials. Do not call
   *   `process.exit` or rely on subprocess-only `hook-utils` helpers — return structured
   *   output so cooldowns and multi-hook dispatch work.
   */
  run(input: TInput): SwizHookOutput | Promise<SwizHookOutput>
}

// ─── Event-specific aliases ───────────────────────────────────────────────────

/** PreToolUse / PostToolUse hook operating on file-edit tools (Edit, Write). */
export type SwizFileEditHook = SwizHook<FileEditHookInput>

/** PreToolUse / PostToolUse hook operating on shell tools (Bash). */
export type SwizShellHook = SwizHook<ShellHookInput>

/** PreToolUse / PostToolUse hook using the generic tool envelope. */
export type SwizToolHook = SwizHook<ToolHookInput>

/** Stop / SubagentStop hook. */
export type SwizStopHook = SwizHook<StopHookInput>

/** SessionStart / UserPromptSubmit / PreCompact hook. */
export type SwizSessionHook = SwizHook<SessionHookInput>
