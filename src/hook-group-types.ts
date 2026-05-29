/**
 * Leaf module: hook group and hook-def types shared between settings and dispatch.
 *
 * Kept free of `EffectiveSwizSettings` imports so that `settings/types.ts` can
 * import `HookGroup` from here without closing the settings ↔ hook-types cycle.
 * `requiredSettings` is widened to `string[]`; callers that need the narrower
 * `keyof EffectiveSwizSettings` constraint (e.g. dispatch/filters.ts) cast at
 * the point of use.
 */

import type { SwizHook } from "./SwizHook.ts"

export type { SwizHook }

/**
 * File-based hook definition — the original format.
 * The dispatcher spawns `bun hooks/<file>` as a subprocess.
 * Prefer InlineHookDef for new hooks.
 */
export interface FileHookDef {
  file: string
  timeout?: number
  async?: boolean
  /** Only meaningful when `async` is true; default is fire-and-forget. */
  asyncMode?: "fire-and-forget" | "block-until-complete"
  cooldownSeconds?: number
  cooldownMode?: "block-only" | "always"
  condition?: string
  stacks?: string[]
  /** Setting keys that must be truthy for this hook to run. */
  requiredSettings?: string[]
}

/**
 * Inline hook definition — the new SwizHook format.
 * The dispatcher calls `hook.run(input)` directly in-process.
 */
export interface InlineHookDef {
  hook: SwizHook
}

/** A manifest hook entry — either file-based or inline. */
export type HookDef = FileHookDef | InlineHookDef

/** Type guard: narrows a HookDef to InlineHookDef. */
export function isInlineHookDef(def: HookDef): def is InlineHookDef {
  return "hook" in def
}

/**
 * Returns the canonical identifier for a hook.
 * Always includes `.ts` for consistency across file-based and inline formats.
 */
export function hookIdentifier(def: HookDef): string {
  if (isInlineHookDef(def)) {
    const name = def.hook.name
    return name.endsWith(".ts") ? name : `${name}.ts`
  }
  return def.file
}

export interface HookGroup {
  event: string
  matcher?: string
  hooks: HookDef[]
  scheduled?: boolean
}
