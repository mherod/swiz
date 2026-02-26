#!/usr/bin/env bun
// Stop hook: Block stop if debug statements found in recently committed files

import { git, isGitRepo, blockStop, SOURCE_EXT_RE, TEST_FILE_RE, type StopHookInput } from "./hook-utils.ts";

export {};

// CLI and hook infrastructure uses console.log as its output channel — not debugging
const INFRA_FILE_RE = /hooks\/|\/commands\/|\/cli\.|index\.ts$|dispatch\.ts$/;

// Debug patterns per language
const JS_DEBUG_RE = /\bconsole\.(log|debug|trace|dir|table)\b/;
const JS_COMMENT_RE = /\/\/.*console\./;
const DEBUGGER_RE = /\bdebugger\b/;
const PY_PRINT_RE = /\bprint\s*\(/;
const PY_EXCLUDE_RE = /# noqa|# debug ok/i;
const RUBY_DEBUG_RE = /binding\.pry|byebug/;

async function main(): Promise<void> {
  const input = (await Bun.stdin.json()) as StopHookInput;
  const cwd = input.cwd;

  if (!(await isGitRepo(cwd))) return;

  const changedRaw = (await git(["diff", "--name-only", "HEAD~10..HEAD"], cwd)) || (await git(["diff", "--name-only", "HEAD"], cwd));
  if (!changedRaw) return;

  // Filter to source files, excluding tests and infrastructure
  const sourceFiles = changedRaw
    .split("\n")
    .filter((f) => SOURCE_EXT_RE.test(f) && !TEST_FILE_RE.test(f) && !INFRA_FILE_RE.test(f));

  if (sourceFiles.length === 0) return;

  const diff = await git(["diff", "HEAD~10..HEAD", "--", ...sourceFiles], cwd);
  if (!diff) return;

  const findings: string[] = [];

  for (const line of diff.split("\n")) {
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    const content = line.slice(1);

    // JS/TS: console.log etc (not in comments)
    if (JS_DEBUG_RE.test(content) && !JS_COMMENT_RE.test(content)) {
      findings.push(line.slice(0, 150));
    }
    // debugger statement
    else if (DEBUGGER_RE.test(content)) {
      findings.push(line.slice(0, 150));
    }
    // Python: print()
    else if (PY_PRINT_RE.test(content) && !PY_EXCLUDE_RE.test(content)) {
      findings.push(line.slice(0, 150));
    }
    // Ruby: binding.pry, byebug
    else if (RUBY_DEBUG_RE.test(content)) {
      findings.push(line.slice(0, 150));
    }

    if (findings.length >= 15) break;
  }

  if (findings.length === 0) return;

  let reason = "Debug statements found in recently committed source files.\n\n";
  reason += `Occurrences (${findings.length}):\n`;
  for (const f of findings) reason += `  ${f}\n`;
  reason += "\nRemove debug statements before stopping. If intentional logging is needed, use a proper logger (e.g., pino, winston) instead.";

  blockStop(reason);
}

main();
