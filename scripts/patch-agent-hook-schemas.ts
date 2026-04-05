#!/usr/bin/env bun
/**
 * Patch agent-hook-schemas dist bundling issues.
 *
 * The 0.2.0 release has a bundler bug where CodexHookEventNameSchema is referenced
 * at module initialization time before being imported. This causes:
 * TypeError: undefined is not an object (evaluating 'CodexHookEventNameSchema.options')
 *
 * Workaround: Replace module-level CODEX_HOOK_EVENTS assignment with lazy evaluation.
 */

import { existsSync, readFileSync, writeFileSync } from "fs"

const chunkPath = "./node_modules/agent-hook-schemas/dist/chunk-PT2BQ5S6.js"

if (!existsSync(chunkPath)) {
  console.warn(`⚠ Skipping patch: ${chunkPath} not found`)
  process.exit(0)
}

let content = readFileSync(chunkPath, "utf-8")
const originalContent = content

// Replace: var CODEX_HOOK_EVENTS = CodexHookEventNameSchema.options;
// With: var CODEX_HOOK_EVENTS;
// Then replace usages to call CodexHookEventNameSchema.options directly
if (content.includes("var CODEX_HOOK_EVENTS = CodexHookEventNameSchema.options")) {
  content = content.replace(
    "var CODEX_HOOK_EVENTS = CodexHookEventNameSchema.options;",
    "var CODEX_HOOK_EVENTS;"
  )

  // Replace usages: "for (const event of CODEX_HOOK_EVENTS)"
  // with "for (const event of CodexHookEventNameSchema.options)"
  content = content.replace(
    /for \(const event of CODEX_HOOK_EVENTS\)/g,
    "for (const event of CodexHookEventNameSchema.options)"
  )

  if (content !== originalContent) {
    writeFileSync(chunkPath, content)
    console.log("✓ Patched agent-hook-schemas bundling issue")
  }
} else {
  console.log("✓ No patch needed (agent-hook-schemas is fixed or not installed)")
}
