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

  if (new RegExp(`(?://|/\\*)\\s*@${kwIgnore}`).test(content)) {
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
  // Valid: // @ts-expect-error: upstream types are wrong
  // Invalid: // @ts-expect-error
  if (new RegExp(`(?://|/\\*)\\s*@${kwExpect}\\s*$`, "m").test(content)) {
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
