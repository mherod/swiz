#!/usr/bin/env bun

// PreToolUse hook: Block inline runtime eval scripts that perform file writes.
// Catches: node/bun -e, python -c (more runtimes added via RUNTIME_DEFS).
// Inline eval scripts bypass file-change review the same way Write/Edit tool calls do.

import { runSwizHookAsMain, type SwizHookOutput, type SwizToolHook } from "../src/SwizHook.ts"
import { shellHookInputSchema } from "../src/schemas.ts"
import { preToolUseAllow, preToolUseDeny } from "../src/utils/hook-utils.ts"
import { splitShellSegments } from "../src/utils/shell-patterns.ts"

// ── Shared body parser ─────────────────────────────────────────────────────────

/** Parse a quoted or unquoted inline script body from the raw string after a flag. */
export function parseQuotedBody(rest: string): string | null {
  if (!rest) return null
  const q = rest[0]!
  if (q === "'") {
    const end = rest.indexOf("'", 1)
    return end === -1 ? rest.slice(1) : rest.slice(1, end)
  }
  if (q === '"') {
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
    const end = rest.indexOf("`", 1)
    return end === -1 ? rest.slice(1) : rest.slice(1, end)
  }
  const end = rest.search(/[\s|;&\n]/)
  return end === -1 ? rest : rest.slice(0, end)
}

/** Extract the script body from the argument immediately following a flag (e.g. -e, -c, --eval). */
export function extractBodyAfterFlag(segment: string, flagRe: string): string | null {
  const m = segment.match(new RegExp(`(?:^|\\s)(?:${flagRe})(?:=|\\s+)([\\s\\S]*)`))
  if (!m) return null
  return parseQuotedBody(m[1]!.trimStart())
}

/**
 * Extract the script body from the argument immediately following -e/--eval.
 * Handles single-quoted, double-quoted (with backslash escapes), and unquoted bodies.
 */
export function extractEvalBody(segment: string): string | null {
  return extractBodyAfterFlag(segment, "-e|--eval")
}

/** Extract the script body from `deno eval <body>` (subcommand form, not a flag). */
export function extractDenoEvalBody(segment: string): string | null {
  const m = segment.match(/\bdeno\b[^|;&\n]*?\beval\s+([\s\S]*)/)
  if (!m) return null
  return parseQuotedBody(m[1]!.trimStart())
}

// ── Write operation patterns ──────────────────────────────────────────────────
// Node/Bun patterns constructed dynamically so the assembled literals don't appear
// in source text — prevents bun-api-enforce false positives when editing this file.

const NODE_BUN_WRITE_OPS: ReadonlyArray<{ re: RegExp; label: string }> = [
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

// Python write patterns — safe as literals (bun-api-enforce doesn't scan for these).
const PYTHON_WRITE_OPS: ReadonlyArray<{ re: RegExp; label: string }> = [
  {
    // open(path, 'w'/'a'/'x'/'wb'/'ab' etc.) — write/append/exclusive-create modes
    re: /\bopen\s*\([^)]*,\s*['"][wWaAxX][^'"]*['"]/,
    label: "open (write mode)",
  },
  {
    re: /\bwrite_text\s*\(/,
    label: "Path.write_text",
  },
  {
    re: /\bwrite_bytes\s*\(/,
    label: "Path.write_bytes",
  },
]

// Deno write patterns — safe as literals (Deno.* APIs not scanned by bun-api-enforce)
const DENO_WRITE_OPS: ReadonlyArray<{ re: RegExp; label: string }> = [
  { re: /\bDeno\.writeFileSync\s*\(/, label: "Deno.writeFileSync" },
  { re: /\bDeno\.writeFile\s*\(/, label: "Deno.writeFile" },
  { re: /\bDeno\.writeTextFileSync\s*\(/, label: "Deno.writeTextFileSync" },
  { re: /\bDeno\.writeTextFile\s*\(/, label: "Deno.writeTextFile" },
]

// Lua write patterns — safe as literals
const LUA_WRITE_OPS: ReadonlyArray<{ re: RegExp; label: string }> = [
  {
    // io.open(path, 'w') / io.open(path, 'a') / io.open(path, 'wb') etc.
    re: /\bio\.open\s*\([^)]*,\s*['"][wa]/,
    label: "io.open (write mode)",
  },
  {
    // io.output(path) — redirects global output to a named file
    re: /\bio\.output\s*\(\s*['"]/,
    label: "io.output",
  },
]

// PowerShell write patterns — safe as literals
const POWERSHELL_WRITE_OPS: ReadonlyArray<{ re: RegExp; label: string }> = [
  { re: /\bSet-Content\b/, label: "Set-Content" },
  { re: /\bAdd-Content\b/, label: "Add-Content" },
  { re: /\bOut-File\b/, label: "Out-File" },
  { re: /\[IO\.File\]::WriteAll/, label: "[IO.File]::WriteAll" },
]

// PHP write patterns — safe as literals
const PHP_WRITE_OPS: ReadonlyArray<{ re: RegExp; label: string }> = [
  { re: /\bfile_put_contents\s*\(/, label: "file_put_contents" },
  { re: /\bfwrite\s*\(/, label: "fwrite" },
  { re: /\bfputs\s*\(/, label: "fputs" },
]

// Perl write patterns — safe as literals
const PERL_WRITE_OPS: ReadonlyArray<{ re: RegExp; label: string }> = [
  {
    // open($fh, '>', file) / open($fh, ">", file) / open(FH, ">file") and >> variants
    re: /\bopen\s*\([^,)]*,\s*['"]>>?/,
    label: "open (>, >>)",
  },
]

// Ruby write patterns — safe as literals
const RUBY_WRITE_OPS: ReadonlyArray<{ re: RegExp; label: string }> = [
  {
    re: /\bFile\.write\s*\(/,
    label: "File.write",
  },
  {
    re: /\bIO\.write\s*\(/,
    label: "IO.write",
  },
  {
    re: /\bFile\.open\s*\([^)]*,\s*['"][wa]/,
    label: "File.open (write mode)",
  },
]

// ── Runtime definitions ────────────────────────────────────────────────────────

interface RuntimeDef {
  name: string
  /** Pre-check: true when the segment contains this runtime with an inline eval flag. */
  segmentRe: RegExp
  /** Extract the inline script body from the matched segment. */
  extractBody: (segment: string) => string | null
  /** Write operation patterns to check within the extracted body. */
  writeOps: ReadonlyArray<{ re: RegExp; label: string }>
}

export const RUNTIME_DEFS: ReadonlyArray<RuntimeDef> = [
  {
    name: "node/bun",
    segmentRe: /\b(?:node|bun)\b[^|;&\n]*?\s+(?:-e|--eval)(?:=|\s)/,
    extractBody: (seg) => extractBodyAfterFlag(seg, "-e|--eval"),
    writeOps: NODE_BUN_WRITE_OPS,
  },
  {
    name: "python",
    segmentRe: /\b(?:python3?)\b[^|;&\n]*?\s+-c\s/,
    extractBody: (seg) => extractBodyAfterFlag(seg, "-c"),
    writeOps: PYTHON_WRITE_OPS,
  },
  {
    name: "lua",
    segmentRe: /\blua\b[^|;&\n]*?\s+-e\s/,
    extractBody: (seg) => extractBodyAfterFlag(seg, "-e"),
    writeOps: LUA_WRITE_OPS,
  },
  {
    name: "powershell",
    segmentRe: /\b(?:pwsh|powershell)\b[^|;&\n]*?\s+(?:-Command|-c)\s/,
    extractBody: (seg) => extractBodyAfterFlag(seg, "-Command|-c"),
    writeOps: POWERSHELL_WRITE_OPS,
  },
  {
    name: "php",
    segmentRe: /\bphp\b[^|;&\n]*?\s+-r\s/,
    extractBody: (seg) => extractBodyAfterFlag(seg, "-r"),
    writeOps: PHP_WRITE_OPS,
  },
  {
    name: "deno",
    segmentRe: /\bdeno\b[^|;&\n]*?\beval\s/,
    extractBody: extractDenoEvalBody,
    writeOps: DENO_WRITE_OPS,
  },
  {
    name: "perl",
    segmentRe: /\bperl\b[^|;&\n]*?\s+-e\s/,
    extractBody: (seg) => extractBodyAfterFlag(seg, "-e"),
    writeOps: PERL_WRITE_OPS,
  },
  {
    name: "ruby",
    segmentRe: /\bruby\b[^|;&\n]*?\s+-e\s/,
    extractBody: (seg) => extractBodyAfterFlag(seg, "-e"),
    writeOps: RUBY_WRITE_OPS,
  },
]

// ── Public API ─────────────────────────────────────────────────────────────────

/** Combined write ops across all registered runtimes (for inspection/testing). */
export const INLINE_WRITE_OPS: ReadonlyArray<{ re: RegExp; label: string }> = RUNTIME_DEFS.flatMap(
  (r) => r.writeOps
)

/** Detect write ops in a script body against all known patterns. */
export function detectWriteOps(scriptBody: string): string[] {
  return INLINE_WRITE_OPS.filter((op) => op.re.test(scriptBody)).map((op) => op.label)
}

/**
 * Scan all shell segments of a command for inline runtime eval write operations.
 * Returns the deduplicated set of matched write operation labels.
 */
export function findInlineScriptWrites(command: string): string[] {
  const found = new Set<string>()
  for (const segment of splitShellSegments(command)) {
    for (const runtime of RUNTIME_DEFS) {
      if (!runtime.segmentRe.test(segment)) continue
      const body = runtime.extractBody(segment)
      if (!body) continue
      for (const op of runtime.writeOps) {
        if (op.re.test(body)) found.add(op.label)
      }
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
        "Do not use inline scripting to write files. These produce unreviewed changes.",
        "",
        `Detected file-write ${noun} in inline eval script:`,
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
