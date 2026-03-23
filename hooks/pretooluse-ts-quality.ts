#!/usr/bin/env bun

// PreToolUse hook: Blocks edits that weaken TypeScript quality.
// Checks for: `as any` casts, eslint-disable comments, @ts-expect-error/@ts-nocheck/@ts-expect-error.
// Merged from pretooluse-no-as-any.ts, pretooluse-no-eslint-disable.ts, pretooluse-no-ts-ignore.ts.

import { fileEditHookInputSchema } from "./schemas.ts"
import { allowPreToolUse, denyPreToolUse, formatActionPlan } from "./utils/hook-utils.ts"

// ─── stripNonCode ────────────────────────────────────────────────────────────

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

function processTemplateLitChar(
  src: string,
  i: number,
  interpDepth: number
): { out: string; nextI: number; nextDepth: number; consumed: boolean } {
  const ch = src[i]
  if (ch === "\\" && interpDepth === 0) {
    return { out: "  ", nextI: i + 2, nextDepth: interpDepth, consumed: true }
  }
  if (ch === "`" && interpDepth === 0) {
    return { out: " ", nextI: i + 1, nextDepth: interpDepth, consumed: true }
  }
  if (ch === "$" && src[i + 1] === "{" && interpDepth === 0) {
    return { out: "  ", nextI: i + 2, nextDepth: 1, consumed: true }
  }
  if (interpDepth > 0) {
    const result = handleInterpChar(ch!, interpDepth)
    return {
      out: result.out,
      nextI: i + 1,
      nextDepth: interpDepth + result.depthDelta,
      consumed: true,
    }
  }
  return { out: ch === "\n" ? "\n" : " ", nextI: i + 1, nextDepth: interpDepth, consumed: false }
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
    const result = processTemplateLitChar(src, i, interpDepth)
    out += result.out
    i = result.nextI
    interpDepth = result.nextDepth
    if (src[i - 1] === "`" && result.nextDepth === 0) break
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

// ─── as any check ────────────────────────────────────────────────────────────

function countAsAnyCasts(content: string): number {
  return (stripNonCode(content).match(/\bas\s+any\b/g) || []).length
}

function checkAsAny(oldString: string, newString: string): void {
  if (!oldString) return
  const oldCount = countAsAnyCasts(oldString)
  const newCount = countAsAnyCasts(newString)
  if (newCount > oldCount) {
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
}

// ─── eslint-disable check ────────────────────────────────────────────────────

function checkEslintDisable(content: string): void {
  // Keyword split across array to avoid self-triggering when editing this hook.
  const kw = ["eslint", "disable"].join("-")
  if (new RegExp(`(?://|/\\*)\\s*${kw}`).test(content)) {
    denyPreToolUse(
      [
        "ESLint is the authority. Do not bypass, ignore, or argue with it.",
        "",
        "You cannot add `eslint-disable` comments. The linter has identified a problem in your code.",
        "",
        formatActionPlan(
          [
            "Read the exact ESLint error message and understand what rule is violated",
            "Fix your code to satisfy the rule",
            "Re-run lint to confirm the error is gone",
            "Never disable the lint-fix the underlying issue",
          ],
          { header: "Your only path forward:" }
        ).trimEnd(),
        "",
        "The linter is not negotiable, not postponeable, not arguable with. It is the source",
        "of truth for code quality. Rules exist because they prevent bugs, enforce consistency,",
        "and maintain the codebase standard. Follow the linter, always.",
      ].join("\n")
    )
  }
}

// ─── ts-ignore / ts-expect-error / ts-nocheck checks ────────────────────────

// stripLineCommentTails removes everything from the first `//` onward on each
// line, excluding `://` (URLs).  The result is used for block-comment detection
// so that a block-comment opener appearing inside a `//` comment is not
// mistaken for an active suppression directive.
function stripLineCommentTails(content: string): string {
  return content
    .split(/\r?\n/)
    .map((line) => {
      const m = line.match(/(?<!:)\/\//)
      return m !== null && m.index !== undefined ? line.slice(0, m.index) : line
    })
    .join("\n")
}

// containsDirective returns true if content contains a suppression directive.
//
// Three detection patterns per directive (all applied with the multiline flag):
//   1. Line comment:   //\s*@directive         — checked on the original content
//   2. Block comment:  /\*\s*@directive         — checked on line-comment-stripped content
//   3. JSDoc interior: ^\s*\*+\s*@directive     — checked on the original content
//
// Pattern 2 uses stripLineCommentTails so that a block-comment opener inside a
// line comment (e.g. in documentation) is not mistaken for an active directive.
// The multiline regex is then applied to the stripped content, so cross-line
// block-comment forms are still detected.
function containsDirective(content: string, directive: string): boolean {
  const re = new RegExp(`(?://\\s*@${directive}|^\\s*\\*+\\s*@${directive})`, "m")
  if (re.test(content)) return true
  return new RegExp(`/\\*\\s*@${directive}`, "m").test(stripLineCommentTails(content))
}

// containsBareExpectError returns true if content has a bare ts-expect-error
// (no description text after the directive).  Uses the same line-comment-tail
// stripping for the block-comment branch as containsDirective.
function containsBareExpectError(content: string, directive: string): boolean {
  const re = new RegExp(`(?://\\s*@${directive}\\s*$|^\\s*\\*+\\s*@${directive}\\s*$)`, "m")
  if (re.test(content)) return true
  return new RegExp(`/\\*\\s*@${directive}(?:\\s*$|\\s*\\*/)`, "m").test(
    stripLineCommentTails(content)
  )
}

function checkTsIgnore(content: string): void {
  // Keywords split across arrays to avoid self-triggering when editing this hook.
  const kwIgnore = ["ts", "ignore"].join("-")
  const kwExpect = ["ts", "expect", "error"].join("-")
  const kwNoCheck = ["ts", "nocheck"].join("-")

  // Block @ts-nocheck — disables ALL type checking for the entire file at once.
  if (containsDirective(content, kwNoCheck)) {
    denyPreToolUse(
      [
        "TypeScript is the authority. Do not bypass, ignore, or argue with it.",
        "",
        `You cannot add \`@${kwNoCheck}\` directives. This disables ALL type checking`,
        "for the entire file, hiding every type error simultaneously.",
        "",
        formatActionPlan(
          [
            "Run tsc to see every type error in the file",
            "Fix each error to satisfy the type system",
            "Remove the directive once all errors are resolved",
            "Never suppress type errors-fix the underlying issues",
          ],
          { header: "Your only path forward:" }
        ).trimEnd(),
        "",
        "The type checker is not negotiable, not postponeable, not arguable with. It is the source",
        "of truth for type safety. Rules exist because they prevent bugs, enforce correctness,",
        "and maintain the codebase standard. Follow the type checker, always.",
      ].join("\n")
    )
  }

  // Block @ts-expect-error unconditionally — it silently accumulates and never self-cleans.
  if (containsDirective(content, kwIgnore)) {
    denyPreToolUse(
      [
        "TypeScript is the authority. Do not bypass, ignore, or argue with it.",
        "",
        `You cannot add \`@${kwIgnore}\` comments. The compiler has identified a type error in your code.`,
        "",
        formatActionPlan(
          [
            "Read the exact TypeScript error message and understand what type constraint is violated",
            "Fix your code to satisfy the type system",
            "Re-run tsc to confirm the error is gone",
            "Never suppress the type error-fix the underlying issue",
          ],
          { header: "Your only path forward:" }
        ).trimEnd(),
        "",
        `If fixing is genuinely impossible (third-party types, impossible narrowing), use \`@${kwExpect}\``,
        `instead. Unlike \`@${kwIgnore}\`, \`@${kwExpect}\` fails compilation when the error goes away,`,
        "keeping suppressions honest and preventing them from accumulating silently.",
        "",
        "The type checker is not negotiable, not postponeable, not arguable with. It is the source",
        "of truth for type safety. Rules exist because they prevent bugs, enforce correctness,",
        "and maintain the codebase standard. Follow the type checker, always.",
      ].join("\n")
    )
  }

  // Allow @ts-expect-error only when accompanied by a description.
  // A bare directive with no explanation is as opaque as @ts-expect-error.
  if (containsBareExpectError(content, kwExpect)) {
    denyPreToolUse(
      [
        `\`@${kwExpect}\` requires a description explaining why suppression is necessary.`,
        "",
        "Bad:  // @ts-expect-error",
        "Good: // @ts-expect-error: upstream types don't include the overloaded signature",
        "",
        "The description is not optional. It documents the intent for future maintainers",
        "and makes it clear the suppression was deliberate, not accidental.",
      ].join("\n")
    )
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const input = fileEditHookInputSchema.parse(await Bun.stdin.json())

  const filePath = input.tool_input?.file_path ?? ""
  if (!/\.(ts|tsx)$/.test(filePath)) {
    process.exit(0)
  }

  // NFKC normalization handled by fileEditHookInputSchema.transform()
  const oldString = input.tool_input?.old_string ?? ""
  const newString = input.tool_input?.new_string ?? input.tool_input?.content ?? ""

  checkAsAny(oldString, newString)
  checkEslintDisable(newString)
  checkTsIgnore(newString)

  allowPreToolUse("")
}

if (import.meta.main) {
  main().catch((e) => {
    console.error("Hook error:", e)
    process.exit(1)
  })
}
