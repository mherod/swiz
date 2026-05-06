#!/usr/bin/env bun

/**
 * PreToolUse hook: Block direct edits to node_modules/.
 *
 * Dual-mode: exports a SwizFileEditHook for inline dispatch and remains
 * executable as a standalone script for backwards compatibility and testing.
 */

import { isNodeModulesPath } from "../src/node-modules-path.ts"
import { runSwizHookAsMain, type SwizFileEditHook } from "../src/SwizHook.ts"
import type { FileEditHookInput } from "../src/schemas.ts"
import { preToolUseAllow, preToolUseDeny } from "../src/utils/hook-utils.ts"

const NODE_MODULES_REASON = [
  "You cannot edit files inside node_modules/.",
  "",
  "node_modules/ contains third-party package code managed exclusively by the package",
  "manager. Any manual edit will be silently overwritten the next time dependencies are",
  "installed, updated, or pruned.",
  "",
  "If the package has a bug, your options are:",
  "  1. Upgrade to a version that fixes the bug",
  "  2. Open an issue or PR upstream",
  "  3. Use a patch tool (e.g. `patch-package`) that re-applies the fix after install",
  "  4. Fork the package and point your dependency at the fork",
  "",
  "Do not edit node_modules/ directly.",
].join("\n")

function evaluate(input: FileEditHookInput) {
  const filePath = input.tool_input?.file_path ?? ""
  if (isNodeModulesPath(filePath)) return preToolUseDeny(NODE_MODULES_REASON)
  return preToolUseAllow(
    `Continue in dependency-source protection mode: ${filePath.split("/").pop()} is outside node_modules/.`
  )
}

const pretoolusNoNodeModulesEdit: SwizFileEditHook = {
  name: "pretooluse-no-node-modules-edit",
  event: "preToolUse",
  matcher: "Edit|Write|NotebookEdit",
  timeout: 5,

  run(input) {
    return evaluate(input)
  },
}

export default pretoolusNoNodeModulesEdit

// ─── Standalone execution (file-based dispatch / manual testing) ────────────
if (import.meta.main) await runSwizHookAsMain(pretoolusNoNodeModulesEdit)
