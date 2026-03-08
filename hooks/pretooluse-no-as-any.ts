#!/usr/bin/env bun

import { allowPreToolUse, denyPreToolUse, formatActionPlan } from "./hook-utils.ts"
import { fileEditHookInputSchema } from "./schemas.ts"

/**
 * Return a copy of {@code src} where every non-code region is replaced with
 * spaces (newlines are preserved for accurate line counts). Non-code regions:
 *   - line comments  (// … \n)
 *   - block comments (/* … *\/)
 *   - quoted strings ("…"  '…')
 *   - template literal body text (outside ${…} interpolations)
 *
 * Expressions inside template literal interpolations (${…}) are preserved
 * because they are real code — a cast there is a genuine violation.
 */
export function stripNonCode(src: string): string {
  let out = ""
  let i = 0
  const n = src.length
  while (i < n) {
    // Line comment — consume to end of line
    if (src[i] === "/" && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n") {
        out += " "
        i++
      }
      continue
    }
    // Block comment — consume until closing delimiter
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
    // Template literal — blank body but keep interpolation content as code
    if (src[i] === "`") {
      out += " "
      i++
      let interpDepth = 0
      while (i < n) {
        if (src[i] === "\\" && interpDepth === 0) {
          out += "  "
          i += 2
          continue
        }
        if (src[i] === "`" && interpDepth === 0) {
          out += " "
          i++
          break
        }
        // ${ opens an interpolation — the content inside is real code
        if (src[i] === "$" && src[i + 1] === "{" && interpDepth === 0) {
          out += "  "
          i += 2
          interpDepth = 1
          continue
        }
        if (interpDepth > 0) {
          if (src[i] === "{") {
            interpDepth++
            out += src[i]
            i++
            continue
          }
          if (src[i] === "}") {
            interpDepth--
            if (interpDepth === 0) {
              out += " "
              i++
              continue
            }
            out += src[i]
            i++
            continue
          }
          // Inside interpolation — preserve real code
          out += src[i]
          i++
        } else {
          out += src[i] === "\n" ? "\n" : " "
          i++
        }
      }
      continue
    }
    // Quoted string — consume until matching unescaped close-quote
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

async function main() {
  const input = fileEditHookInputSchema.parse(await Bun.stdin.json())

  const filePath = input.tool_input?.file_path ?? ""
  const isTypeScriptFile = /\.(ts|tsx)$/.test(filePath)

  if (!isTypeScriptFile) {
    process.exit(0)
  }

  // NFKC normalization handled by fileEditHookInputSchema.transform()
  const oldString = input.tool_input?.old_string ?? ""
  const newString = input.tool_input?.new_string ?? input.tool_input?.content ?? ""

  // If no old_string (new file), check if it has as any but don't block for new files
  // (they might be generated or have necessary escapes)
  if (!oldString) {
    process.exit(0)
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
      formatActionPlan([
        "Type the value correctly using proper TypeScript types",
        "Use `unknown` temporarily with proper type guards to narrow it down",
        "If the library is untyped, add or use @types definitions",
        "Use `as const` if you need to constrain a literal value",
        "Use generic types to accept the value's actual type",
      ]).trimEnd(),
      "",
      "Never `as any`. Fix the type instead. The type system exists to prevent bugs.",
      "Every `as any` is a future bug waiting to happen.",
    ].join("\n")

    denyPreToolUse(reason)
  }

  allowPreToolUse("")
}

if (import.meta.main) {
  main().catch((e) => {
    console.error("Hook error:", e)
    process.exit(1)
  })
}
