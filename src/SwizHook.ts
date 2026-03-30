/**
 * SwizHook — self-describing inline hook interface.
 *
 * A SwizHook is a self-contained hook object that carries its own dispatch
 * metadata (event, matcher, timeout, cooldown, requiredSettings) alongside a
 * typed run() function. Hooks defined this way can be registered directly in
 * the manifest and executed in-process — no subprocess spawn required.
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

import type {
  FileEditHookInput,
  SessionHookInput,
  ShellHookInput,
  StopHookInput,
  ToolHookInput,
} from "../hooks/schemas.ts"
import type { EffectiveSwizSettings } from "./settings/types.ts"

// ─── Standalone runner ──────────────────────────────────────────────────────

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
export async function runSwizHookAsMain(hook: SwizHook<Record<string, unknown>>): Promise<void> {
  const input = (await Bun.stdin.json().catch(() => null)) as Record<string, unknown> | null
  if (!input) process.exit(0)

  // Inject effective settings when missing (subprocess path)
  if (!input._effectiveSettings) {
    const { getEffectiveSwizSettings, readSwizSettings } = await import("./settings.ts")
    const sessionId = typeof input.session_id === "string" ? input.session_id : null
    const rawSettings = await readSwizSettings()
    input._effectiveSettings = getEffectiveSwizSettings(
      rawSettings,
      sessionId
    ) as unknown as Record<string, unknown>
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
export type HookOutput = Record<string, unknown>

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
  /** When true, hook runs fire-and-forget without blocking the dispatch chain. */
  async?: boolean
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
   *   without a hint. Return `{ decision: "deny", reason: "..." }` to block.
   */
  run(input: TInput): HookOutput | Promise<HookOutput>
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
