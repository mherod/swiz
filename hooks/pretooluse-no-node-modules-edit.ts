#!/usr/bin/env bun

import { denyPreToolUse } from "./hook-utils.ts"

interface HookInput {
  tool_name: string
  tool_input?: {
    file_path?: string
  }
}

async function main() {
  const input: HookInput = await Bun.stdin.json()

  const filePath = input.tool_input?.file_path ?? ""

  if (/(^|[\\/])node_modules[\\/]/.test(filePath)) {
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

  // Allow the edit
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
      },
    })
  )
}

main().catch((e) => {
  console.error("Hook error:", e)
  process.exit(1)
})
