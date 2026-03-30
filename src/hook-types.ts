/**
 * Shared hook type definitions used by manifest.ts, settings/persistence.ts,
 * dispatch engine, and filters. Extracted to break the circular dependency:
 * manifest.ts → hook files → git-utils.ts → settings.ts → persistence.ts → manifest.ts
 */

import type { SwizHook } from "./SwizHook.ts"
import type { EffectiveSwizSettings } from "./settings"

export type { SwizHook }

/**
 * File-based hook definition — the original format.
 * The dispatcher spawns `bun hooks/<file>` as a subprocess.
 * @deprecated Use InlineHookDef instead.
 */
export interface FileHookDef {
  file: string
  timeout?: number
  async?: boolean
  cooldownSeconds?: number
  cooldownMode?: "block-only" | "always"
  condition?: string
  stacks?: string[]
  requiredSettings?: (keyof EffectiveSwizSettings)[]
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
