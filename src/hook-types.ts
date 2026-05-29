/**
 * Shared hook type definitions used by manifest.ts, settings/persistence.ts,
 * dispatch engine, and filters. Extracted to break the circular dependency:
 * manifest.ts → hook files → git-utils.ts → settings.ts → persistence.ts → manifest.ts
 *
 * All types are re-exported from hook-group-types.ts so that settings/types.ts
 * can import HookGroup from there without closing the settings ↔ hook-types cycle.
 */

export type {
  FileHookDef,
  HookDef,
  HookGroup,
  InlineHookDef,
  SwizHook,
} from "./hook-group-types.ts"
export { hookIdentifier, isInlineHookDef } from "./hook-group-types.ts"
