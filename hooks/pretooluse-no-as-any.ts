#!/usr/bin/env bun

import { denyPreToolUse } from "./hook-utils.ts"

interface HookInput {
  tool_name: string
  tool_input?: {
    file_path?: string
    old_string?: string
    new_string?: string
    content?: string
  }
}

async function main() {
  const input: HookInput = await Bun.stdin.json()

  const filePath = input.tool_input?.file_path ?? ""
  const isTypeScriptFile = /\.(ts|tsx)$/.test(filePath)

  if (!isTypeScriptFile) {
    process.exit(0)
  }

  const oldString = input.tool_input?.old_string ?? ""
  const newString = input.tool_input?.new_string ?? input.tool_input?.content ?? ""

  // If no old_string (new file), check if it has as any but don't block for new files
  // (they might be generated or have necessary escapes)
  if (!oldString) {
    process.exit(0)
  }

  // Count "as any" in old vs new
  const oldAsAnyCount = (oldString.match(/\bas\s+any\b/g) || []).length
  const newAsAnyCount = (newString.match(/\bas\s+any\b/g) || []).length

  // Block if new "as any" is being added
  if (newAsAnyCount > oldAsAnyCount) {
    const reason = [
      "Type safety is non-negotiable. Do not add `as any` casts.",
      "",
      "The `as any` escape hatch destroys type safety and creates technical debt. It's a",
      "silent agreement to abandon the type system at that point in the code.",
      "",
      "Your only options:",
      "  1. Type the value correctly using proper TypeScript types",
      "  2. Use `unknown` temporarily with proper type guards to narrow it down",
      "  3. If the library is untyped, add or use @types definitions",
      "  4. Use `as const` if you need to constrain a literal value",
      "  5. Use generic types to accept the value's actual type",
      "",
      "Never `as any`. Fix the type instead. The type system exists to prevent bugs.",
      "Every `as any` is a future bug waiting to happen.",
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
