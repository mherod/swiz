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

  // Scan only the code tokens — skip string literals and comments so that
  // natural-language phrases in test descriptions or doc-comments are not
  // counted as casts. The function blanks out all non-code regions before
  // the regex runs.
  function stripNonCode(src: string): string {
    let out = ""
    let i = 0
    const n = src.length
    while (i < n) {
      // Line comment: consume until end of line
      if (src[i] === "/" && src[i + 1] === "/") {
        while (i < n && src[i] !== "\n") {
          out += " "
          i++
        }
        continue
      }
      // Block comment: consume until closing delimiter
      if (src[i] === "/" && src[i + 1] === "*") {
        out += "  "
        i += 2
        while (i < n) {
          if (src[i] === "*" && src[i + 1] === "/") {
            out += "  "
            i += 2
            break
          }
          out += src[i] === "\n" ? "\n" : " "
          i++
        }
        continue
      }
      // Template literal: consume until unescaped back-tick (no interpolation tracking needed)
      if (src[i] === "`") {
        out += " "
        i++
        while (i < n) {
          if (src[i] === "\\") {
            out += "  "
            i += 2
            continue
          }
          if (src[i] === "`") {
            out += " "
            i++
            break
          }
          out += src[i] === "\n" ? "\n" : " "
          i++
        }
        continue
      }
      // Quoted string: consume until matching unescaped close-quote
      if (src[i] === '"' || src[i] === "'") {
        const q = src[i]
        out += " "
        i++
        while (i < n) {
          if (src[i] === "\\") {
            out += "  "
            i += 2
            continue
          }
          if (src[i] === q) {
            out += " "
            i++
            break
          }
          out += src[i] === "\n" ? "\n" : " "
          i++
        }
        continue
      }
      out += src[i]
      i++
    }
    return out
  }

  // Count the cast pattern in code-only regions of old vs new
  const castRe = /\bas\s+any\b/g
  const oldAsAnyCount = (stripNonCode(oldString).match(castRe) || []).length
  const newAsAnyCount = (stripNonCode(newString).match(castRe) || []).length

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
