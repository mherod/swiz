#!/usr/bin/env bun

import { denyPreToolUse, formatActionPlan } from "./hook-utils.ts"
import { fileEditHookInputSchema } from "./schemas.ts"

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

async function main() {
  const input = fileEditHookInputSchema.parse(await Bun.stdin.json())

  const filePath = input.tool_input?.file_path ?? ""
  const isTypeScriptFile = /\.(ts|tsx)$/.test(filePath)

  if (!isTypeScriptFile) {
    process.exit(0)
  }

  // NFKC normalization handled by fileEditHookInputSchema.transform()
  const content = input.tool_input?.new_string ?? input.tool_input?.content ?? ""

  // Keywords split across arrays to avoid self-triggering when editing this hook.
  const kwIgnore = ["ts", "ignore"].join("-")
  const kwExpect = ["ts", "expect", "error"].join("-")
  const kwNoCheck = ["ts", "nocheck"].join("-")

  // Block @ts-nocheck — disables ALL type checking for the entire file at once.
  if (containsDirective(content, kwNoCheck)) {
    const reason = [
      "TypeScript is the authority. Do not bypass, ignore, or argue with it.",
      "",
      `You cannot add \`@${kwNoCheck}\` directives. This disables ALL type checking`,
      "for the entire file, hiding every type error simultaneously.",
      "",
      "Your only path forward:",
      formatActionPlan([
        "Run tsc to see every type error in the file",
        "Fix each error to satisfy the type system",
        "Remove the directive once all errors are resolved",
        "Never suppress type errors-fix the underlying issues",
      ]).trimEnd(),
      "",
      "The type checker is not negotiable, not postponeable, not arguable with. It is the source",
      "of truth for type safety. Rules exist because they prevent bugs, enforce correctness,",
      "and maintain the codebase standard. Follow the type checker, always.",
    ].join("\n")

    denyPreToolUse(reason)
  }

  // Block @ts-expect-error unconditionally — it silently accumulates and never self-cleans.
  if (containsDirective(content, kwIgnore)) {
    const reason = [
      "TypeScript is the authority. Do not bypass, ignore, or argue with it.",
      "",
      `You cannot add \`@${kwIgnore}\` comments. The compiler has identified a type error in your code.`,
      "",
      "Your only path forward:",
      formatActionPlan([
        "Read the exact TypeScript error message and understand what type constraint is violated",
        "Fix your code to satisfy the type system",
        "Re-run tsc to confirm the error is gone",
        "Never suppress the type error-fix the underlying issue",
      ]).trimEnd(),
      "",
      `If fixing is genuinely impossible (third-party types, impossible narrowing), use \`@${kwExpect}\``,
      `instead. Unlike \`@${kwIgnore}\`, \`@${kwExpect}\` fails compilation when the error goes away,`,
      "keeping suppressions honest and preventing them from accumulating silently.",
      "",
      "The type checker is not negotiable, not postponeable, not arguable with. It is the source",
      "of truth for type safety. Rules exist because they prevent bugs, enforce correctness,",
      "and maintain the codebase standard. Follow the type checker, always.",
    ].join("\n")

    denyPreToolUse(reason)
  }

  // Allow @ts-expect-error only when accompanied by a description.
  // A bare directive with no explanation is as opaque as @ts-expect-error.
  if (containsBareExpectError(content, kwExpect)) {
    const reason = [
      `\`@${kwExpect}\` requires a description explaining why suppression is necessary.`,
      "",
      "Bad:  // @ts-expect-error",
      "Good: // @ts-expect-error: upstream types don't include the overloaded signature",
      "",
      "The description is not optional. It documents the intent for future maintainers",
      "and makes it clear the suppression was deliberate, not accidental.",
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
