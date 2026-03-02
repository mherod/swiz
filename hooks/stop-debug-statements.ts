#!/usr/bin/env bun
// Stop hook: Block stop if debug statements found in recently committed files

import {
  blockStop,
  git,
  isGitRepo,
  SOURCE_EXT_RE,
  type StopHookInput,
  TEST_FILE_RE,
} from "./hook-utils.ts"

// CLI and hook infrastructure uses console.log as its output channel — not debugging
const INFRA_FILE_RE = /hooks\/|\/commands\/|\/cli\.|index\.ts$|dispatch\.ts$/

// Compiled/generated artifacts contain machine-written console calls — not authored debug statements
const GENERATED_FILE_RE = /main\.dart\.js$|\.dart\.js$|\.min\.js$|\.bundle\.js$|\.chunk\.js$/

// Debug patterns per language
const JS_DEBUG_RE = /\bconsole\.(log|debug|trace|dir|table)\b/
const JS_COMMENT_RE = /\/\/.*console\./
const DEBUGGER_RE = /\bdebugger\b/
const ESLINT_DEBUGGER_RULE_RE = /["']no-debugger["']/
const PY_PRINT_RE = /\bprint\s*\(/
const PY_EXCLUDE_RE = /# noqa|# debug ok/i
const RUBY_DEBUG_RE = /\b(?:binding\.pry|byebug)\b/

async function main(): Promise<void> {
  const input = (await Bun.stdin.json()) as StopHookInput
  const cwd = input.cwd

  if (!(await isGitRepo(cwd))) return

  // Use HEAD~10 as the diff base when available; fall back to the git empty-tree
  // SHA so the range resolves correctly in repos with fewer than 11 commits.
  const GIT_EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
  const base = (await git(["rev-parse", "--verify", "HEAD~10"], cwd)) || GIT_EMPTY_TREE
  const range = `${base}..HEAD`

  const changedRaw = await git(["diff", "--name-only", range], cwd)
  if (!changedRaw) return

  // Filter to source files, excluding tests and infrastructure
  const sourceFiles = changedRaw
    .split("\n")
    .filter(
      (f) =>
        SOURCE_EXT_RE.test(f) &&
        !TEST_FILE_RE.test(f) &&
        !INFRA_FILE_RE.test(f) &&
        !GENERATED_FILE_RE.test(f)
    )

  if (sourceFiles.length === 0) return

  const diff = await git(["diff", range, "--", ...sourceFiles], cwd)
  if (!diff) return

  const findings: string[] = []

  for (const line of diff.split("\n")) {
    if (!line.startsWith("+") || line.startsWith("+++")) continue
    const content = line.slice(1)

    // JS/TS: console.log etc (not in comments)
    if (JS_DEBUG_RE.test(content) && !JS_COMMENT_RE.test(content)) {
      findings.push(line.slice(0, 150))
    }
    // debugger statement (exclude ESLint rule configs like "no-debugger": "warn")
    else if (DEBUGGER_RE.test(content) && !ESLINT_DEBUGGER_RULE_RE.test(content)) {
      findings.push(line.slice(0, 150))
    }
    // Python: print()
    else if (PY_PRINT_RE.test(content) && !PY_EXCLUDE_RE.test(content)) {
      findings.push(line.slice(0, 150))
    }
    // Ruby: binding.pry, byebug
    else if (RUBY_DEBUG_RE.test(content)) {
      findings.push(line.slice(0, 150))
    }

    if (findings.length >= 15) break
  }

  if (findings.length === 0) return

  let reason = "Debug statements found in recently committed source files.\n\n"
  reason += `Occurrences (${findings.length}):\n`
  for (const f of findings) reason += `  ${f}\n`
  reason +=
    "\nRemove debug statements before stopping. If intentional logging is needed, use a proper logger (e.g., pino, winston) instead."

  blockStop(reason)
}

main()
