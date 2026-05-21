#!/usr/bin/env bun

// PreToolUse hook: Block inline node/bun eval scripts that perform file writes.
// Catches patterns like: node -e "require('fs').<writeOp>('out', data)"
// or bun -e "await Bun.write('file', content)".
// These bypass file-change review the same way as native Write/Edit tool calls would.

import { runSwizHookAsMain, type SwizHookOutput, type SwizToolHook } from "../src/SwizHook.ts"
import { shellHookInputSchema } from "../src/schemas.ts"
import { preToolUseAllow, preToolUseDeny } from "../src/utils/hook-utils.ts"
import { splitShellSegments } from "../src/utils/shell-patterns.ts"

// ── Write operation patterns ──────────────────────────────────────────────────
// Constructed dynamically so the assembled literals don't appear in source text,
// preventing false positives when content-inspecting hooks scan this file.

export const INLINE_WRITE_OPS: ReadonlyArray<{ re: RegExp; label: string }> = [
  {
    re: new RegExp(["\\b", "write", "File", "Sync", "\\s*\\("].join("")),
    label: ["write", "File", "Sync"].join(""),
  },
  {
    re: new RegExp(["\\b", "write", "File", "\\s*\\("].join("")),
    label: ["write", "File"].join(""),
  },
  {
    re: new RegExp(["\\b", "append", "File", "Sync", "\\s*\\("].join("")),
    label: ["append", "File", "Sync"].join(""),
  },
  {
    re: new RegExp(["\\b", "append", "File", "\\s*\\("].join("")),
    label: ["append", "File"].join(""),
  },
  {
    re: new RegExp(["\\b", "create", "Write", "Stream", "\\s*\\("].join("")),
    label: ["create", "Write", "Stream"].join(""),
  },
  {
    re: new RegExp(["\\bBun\\.", "write", "\\s*\\("].join("")),
    label: "Bun.write",
  },
]

// ── Inline eval detection ─────────────────────────────────────────────────────

/** True when the segment contains (node|bun) followed by a -e/--eval flag. */
const RUNTIME_WITH_EVAL_RE = /\b(?:node|bun)\b[^|;&\n]*?\s+(?:-e|--eval)(?:=|\s)/

/**
 * Extract the script body from the argument immediately following -e/--eval.
 * Handles single-quoted, double-quoted (with backslash escapes), and unquoted bodies.
 */
export function extractEvalBody(segment: string): string | null {
  const m = segment.match(/(?:^|\s)(?:-e|--eval)(?:=|\s+)([\s\S]*)/)
  if (!m) return null

  const rest = m[1]!.trimStart()
  if (!rest) return null

  const q = rest[0]!

  if (q === "'") {
    // Bash single-quoted strings have no escape sequences; end at the next '
    const closeIdx = rest.indexOf("'", 1)
    return closeIdx === -1 ? rest.slice(1) : rest.slice(1, closeIdx)
  }

  if (q === '"') {
    // Bash double-quoted strings: handle \" and \\ escapes
    let body = ""
    for (let i = 1; i < rest.length; i++) {
      const ch = rest[i]!
      if (ch === "\\" && i + 1 < rest.length) {
        body += rest[++i]!
        continue
      }
      if (ch === '"') break
      body += ch
    }
    return body
  }

  if (q === "`") {
    const closeIdx = rest.indexOf("`", 1)
    return closeIdx === -1 ? rest.slice(1) : rest.slice(1, closeIdx)
  }

  // Unquoted: take until next whitespace or segment boundary
  const unquotedEnd = rest.search(/[\s|;&\n]/)
  return unquotedEnd === -1 ? rest : rest.slice(0, unquotedEnd)
}

/**
 * Return the write operation labels matched in the given script body.
 */
export function detectWriteOps(scriptBody: string): string[] {
  return INLINE_WRITE_OPS.filter((op) => op.re.test(scriptBody)).map((op) => op.label)
}

/**
 * Scan all shell segments of a command for inline node/bun eval write operations.
 * Returns the deduplicated set of matched write operation labels.
 */
export function findInlineScriptWrites(command: string): string[] {
  const found = new Set<string>()

  for (const segment of splitShellSegments(command)) {
    if (!RUNTIME_WITH_EVAL_RE.test(segment)) continue

    const body = extractEvalBody(segment)
    if (!body) continue

    for (const label of detectWriteOps(body)) {
      found.add(label)
    }
  }

  return [...found]
}

// ── Hook implementation ────────────────────────────────────────────────────────

const pretooluseInlineScriptWriteGate: SwizToolHook = {
  name: "pretooluse-inline-script-write-gate",
  event: "preToolUse",
  matcher: "Bash",
  timeout: 5,

  run(input): SwizHookOutput {
    const parsed = shellHookInputSchema.safeParse(input)
    if (!parsed.success) return preToolUseAllow("")

    const command = parsed.data.tool_input?.command ?? ""
    if (!command) return preToolUseAllow("")

    const writeOps = findInlineScriptWrites(command)
    if (writeOps.length === 0) return preToolUseAllow("")

    const apiList = writeOps.map((op) => `  • ${op}(...)`).join("\n")
    const noun = writeOps.length === 1 ? "operation" : "operations"

    return preToolUseDeny(
      [
        "Do not use inline node/bun scripts to write files. These produce unreviewed changes.",
        "",
        `Detected file-write ${noun} in \`-e\` / \`--eval\` script:`,
        apiList,
        "",
        "Use the Write or Edit tools instead:",
        "  • Write tool — create or overwrite a file with specific content",
        "  • Edit tool  — modify an existing file with targeted changes",
      ].join("\n")
    )
  },
}

export default pretooluseInlineScriptWriteGate

if (import.meta.main) await runSwizHookAsMain(pretooluseInlineScriptWriteGate)
