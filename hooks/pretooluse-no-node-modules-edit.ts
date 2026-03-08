#!/usr/bin/env bun

import { isNodeModulesPath } from "../src/node-modules-path.ts"
import { allowPreToolUse, denyPreToolUse } from "./hook-utils.ts"
import { fileEditHookInputSchema } from "./schemas.ts"

async function main() {
  const input = fileEditHookInputSchema.parse(await Bun.stdin.json())

  const filePath = input.tool_input?.file_path ?? ""

  if (isNodeModulesPath(filePath)) {
    const reason = [
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

    denyPreToolUse(reason)
  }

  allowPreToolUse("")
}

main().catch((e) => {
  console.error("Hook error:", e)
  process.exit(1)
})
