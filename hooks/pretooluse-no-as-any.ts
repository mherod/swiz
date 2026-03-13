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
function stripLineComment(
  src: string,
  i: number,
  n: number,
  out: string
): { out: string; i: number } {
  while (i < n && src[i] !== "\n") {
    out += " "
    i++
  }
  return { out, i }
}

function stripBlockComment(
  src: string,
  i: number,
  n: number,
  out: string
): { out: string; i: number } {
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
  return { out, i }
}

function handleInterpChar(ch: string, depth: number): { out: string; depthDelta: number } {
  if (ch === "{") return { out: ch, depthDelta: 1 }
  if (ch === "}") {
    if (depth === 1) return { out: " ", depthDelta: -1 }
    return { out: ch, depthDelta: -1 }
  }
  return { out: ch, depthDelta: 0 }
}

function stripTemplateLiteral(
  src: string,
  i: number,
  n: number,
  out: string
): { out: string; i: number } {
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
    if (src[i] === "$" && src[i + 1] === "{" && interpDepth === 0) {
      out += "  "
      i += 2
      interpDepth = 1
      continue
    }
    if (interpDepth > 0) {
      const result = handleInterpChar(src[i]!, interpDepth)
      out += result.out
      interpDepth += result.depthDelta
      i++
      continue
    }
    out += src[i] === "\n" ? "\n" : " "
    i++
  }
  return { out, i }
}

function stripQuotedString(
  src: string,
  i: number,
  n: number,
  out: string
): { out: string; i: number } {
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
  return { out, i }
}

export function stripNonCode(src: string): string {
  let out = ""
  let i = 0
  const n = src.length
  while (i < n) {
    if (src[i] === "/" && src[i + 1] === "/") {
      ;({ out, i } = stripLineComment(src, i, n, out))
      continue
    }
    if (src[i] === "/" && src[i + 1] === "*") {
      ;({ out, i } = stripBlockComment(src, i, n, out))
      continue
    }
    if (src[i] === "`") {
      ;({ out, i } = stripTemplateLiteral(src, i, n, out))
      continue
    }
    if (src[i] === '"' || src[i] === "'") {
      ;({ out, i } = stripQuotedString(src, i, n, out))
      continue
    }
    out += src[i]
    i++
  }
  return out
}

function countAsAnyCasts(content: string): number {
  return (stripNonCode(content).match(/\bas\s+any\b/g) || []).length
}

async function main() {
  const input = fileEditHookInputSchema.parse(await Bun.stdin.json())

  const filePath = input.tool_input?.file_path ?? ""
  if (!/\.(ts|tsx)$/.test(filePath)) {
    process.exit(0)
  }

  const oldString = input.tool_input?.old_string ?? ""
  const newString = input.tool_input?.new_string ?? input.tool_input?.content ?? ""

  if (!oldString) {
    process.exit(0)
  }

  const oldAsAnyCount = countAsAnyCasts(oldString)
  const newAsAnyCount = countAsAnyCasts(newString)

  if (newAsAnyCount > oldAsAnyCount) {
    denyPreToolUse(
      [
        "Type safety is non-negotiable. Do not add `as any` casts.",
        "",
        "The `as any` escape hatch destroys type safety and creates technical debt. It's a",
        "silent agreement to abandon the type system at that point in the code.",
        "",
        formatActionPlan(
          [
            "Type the value correctly using proper TypeScript types",
            "Use `unknown` temporarily with proper type guards to narrow it down",
            "If the library is untyped, add or use @types definitions",
            "Use `as const` if you need to constrain a literal value",
            "Use generic types to accept the value's actual type",
          ],
          { header: "Your only options:" }
        ).trimEnd(),
        "",
        "Never `as any`. Fix the type instead. The type system exists to prevent bugs.",
        "Every `as any` is a future bug waiting to happen.",
      ].join("\n")
    )
  }

  allowPreToolUse("")
}

if (import.meta.main) {
  main().catch((e) => {
    console.error("Hook error:", e)
    process.exit(1)
  })
}
