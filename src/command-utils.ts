// ─── Shell command normalisation utilities ──────────────────────────────────
//
// Pure functions for normalising and transforming shell command strings.
// Used by transcript-summary parsing and hook scripts that inspect Bash tool
// calls. Extracted from hooks/hook-utils.ts (issue #84).

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
