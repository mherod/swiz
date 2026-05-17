// ─── Shell command normalisation utilities ──────────────────────────────────
//
// Pure functions for normalising and transforming shell command strings.
// Used by transcript-summary parsing and hook scripts that inspect Bash tool
// calls. Extracted from hooks/hook-utils.ts (issue #84).

import { splitShellSegments } from "./utils/shell-patterns.ts"

/**
 * Normalize shell backslash-newline continuations so that
 *   git branch \<newline>  --show-current
 * is treated identically to
 *   git branch --show-current
 * before regex checks run.
 */
export function normalizeCommand(cmd: string): string {
  // \r?\n handles both LF and CRLF line endings in backslash continuations
  return cmd.replace(/\\\r?\n\s*/g, " ")
}

/**
 * Strip heredoc bodies from a shell command string before regex matching.
 * Prevents false positives when git push/commit appears inside a heredoc body
 * rather than as an executable command.
 * Handles: <<WORD, <<-WORD, <<"WORD", <<'WORD'
 */
export function stripHeredocs(command: string): string {
  return command.replace(/<<-?[ \t]*["']?(\w+)["']?[ \t]*\n[\s\S]*?\n[ \t]*\1(?=\n|$)/g, "")
}

const BUN_TEST_FILE_RE = /(?:\.\/)?[\w./-]+\.(?:test|spec)\.\w+/

/**
 * Return the argument suffix for every real `bun test` shell invocation.
 * Quoted occurrences like `rg "|bun test"` are treated as argument text.
 */
export function bunTestArgSegments(command: string): string[] {
  return splitShellSegments(normalizeCommand(command))
    .map((segment) => segment.match(/^bun\s+test\b(.*)$/)?.[1] ?? null)
    .filter((segment): segment is string => segment !== null)
}

/** Returns true when `bun test` args target exactly one test file. */
export function isSingleFileBunTestArgs(segment: string): boolean {
  const stripped = segment
    .replace(/\s+--\w[\w-]*(?:=\S+)?/g, "") // flags (--flag or --flag=value)
    .replace(/\s*(?:[12]?>>?|2>&1|>&)\s*\S+/g, "") // redirections
    .replace(/\s*\|.*$/g, "") // pipes and everything after
    .trim()
  const positionals = stripped.split(/\s+/).filter(Boolean)
  const testFiles = positionals.filter((p) => BUN_TEST_FILE_RE.test(p))
  return testFiles.length === 1
}
