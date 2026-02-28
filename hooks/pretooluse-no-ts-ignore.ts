#!/usr/bin/env bun

import { denyPreToolUse } from "./hook-utils.ts"

interface HookInput {
  tool_name: string
  tool_input?: {
    file_path?: string
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

  const content = input.tool_input?.new_string ?? input.tool_input?.content ?? ""

  // Scope the check to actual comment-level compiler directives, not filenames or strings.
  // Keywords split across arrays to avoid self-triggering when editing this hook.

  // Block @ts-ignore unconditionally — it silently accumulates and never self-cleans.
  const kwIgnore = ["ts", "ignore"].join("-")
  const kwExpect = ["ts", "expect", "error"].join("-")

  // Block @ts-nocheck — disables ALL type checking for the entire file at once.
  // Keywords split across array to avoid self-triggering when editing this hook.
  //
  // Three detection patterns (all with multiline flag):
  //   1. //\s*@directive       — line comment
  //   2. /\*\s*@directive      — direct block comment (/* @directive, /*@directive, /*\n@directive)
  //   3. ^\s*\*\s*@directive   — JSDoc interior line (" * @directive"), anchored to line start
  //
  // Pattern 3 catches directives on any JSDoc line regardless of preceding content
  // (e.g. "/**\n * Some doc\n * @ts-ignore\n */") without false-positiving on
  // "/* some text, @ts-ignore */" where the * is mid-line, not line-start.
  const kwNoCheck = ["ts", "nocheck"].join("-")
  if (
    new RegExp(
      `(?://\\s*@${kwNoCheck}|/\\*\\s*@${kwNoCheck}|^\\s*\\*\\s*@${kwNoCheck})`,
      "m"
    ).test(content)
  ) {
    const reason = [
      "TypeScript is the authority. Do not bypass, ignore, or argue with it.",
      "",
      `You cannot add \`@${kwNoCheck}\` directives. This disables ALL type checking`,
      "for the entire file, hiding every type error simultaneously.",
      "",
      "Your only path forward:",
      "  1. Run tsc to see every type error in the file",
      "  2. Fix each error to satisfy the type system",
      "  3. Remove the directive once all errors are resolved",
      "  4. Never suppress type errors—fix the underlying issues",
      "",
      "The type checker is not negotiable, not postponeable, not arguable with. It is the source",
      "of truth for type safety. Rules exist because they prevent bugs, enforce correctness,",
      "and maintain the codebase standard. Follow the type checker, always.",
    ].join("\n")

    denyPreToolUse(reason)
  }

  // Same three-pattern approach for @ts-ignore.
  if (
    new RegExp(
      `(?://\\s*@${kwIgnore}|/\\*\\s*@${kwIgnore}|^\\s*\\*\\s*@${kwIgnore})`,
      "m"
    ).test(content)
  ) {
    const reason = [
      "TypeScript is the authority. Do not bypass, ignore, or argue with it.",
      "",
      `You cannot add \`@${kwIgnore}\` comments. The compiler has identified a type error in your code.`,
      "",
      "Your only path forward:",
      "  1. Read the exact TypeScript error message and understand what type constraint is violated",
      "  2. Fix your code to satisfy the type system",
      "  3. Re-run tsc to confirm the error is gone",
      "  4. Never suppress the type error—fix the underlying issue",
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
  // A bare directive with no explanation is as opaque as @ts-ignore.
  // Three bare forms are caught:
  //   1. Line comment at EOL:           //\s*@directive\s*$
  //   2. Direct block comment:          /\*\s*@directive(\s*$|\s*\*/)
  //   3. JSDoc interior at EOL:         ^\s*\*\s*@directive\s*$
  // A description — any non-whitespace text after the directive — allows it through.
  const bareExpectRe = new RegExp(
    `(?://\\s*@${kwExpect}\\s*$|/\\*\\s*@${kwExpect}(?:\\s*$|\\s*\\*/)|^\\s*\\*\\s*@${kwExpect}\\s*$)`,
    "m"
  )
  if (bareExpectRe.test(content)) {
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
