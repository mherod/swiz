/**
 * Tracks when a SwizHook `run()` is executing inside the dispatch engine (inline mode).
 * In this context, `exitWithHookObject` / `process.exit` must not run — hook output is
 * returned to the strategy pipeline instead.
 */

import { AsyncLocalStorage } from "node:async_hooks"
import type { HookOutput } from "./schemas.ts"

const inlineRun = new AsyncLocalStorage<boolean>()

export function isInlineSwizHookRun(): boolean {
  return inlineRun.getStore() === true
}

/** Run `fn` with inline SwizHook dispatch context active (for `runInlineHook` only). */
export function withInlineSwizHookRun<T>(fn: () => Promise<T>): Promise<T> {
  return inlineRun.run(true, fn)
}

/**
 * Thrown when subprocess-style helpers (`denyPreToolUse`, `emitContext`, etc.) are invoked
 * during inline dispatch. Carries the hook JSON that would have been written to stdout.
 * Prefer returning {@link SwizHookOutput} from `hook.run()` instead.
 */
export class SwizHookExit extends Error {
  readonly output: HookOutput

  constructor(output: HookOutput) {
    super(
      "Subprocess-only hook helper was called during inline SwizHook.run(); return hook output from run() instead (preToolUseAllow/preToolUseDeny, buildContextHookOutput, etc.)."
    )
    this.name = "SwizHookExit"
    this.output = output
  }
}
