// Shared shell-boundary regex helpers for hook command matching.
//
// Exported write-detection patterns (shared across hooks):

/**
 * Matches piped tee writes: `echo foo | tee file` and `command | tee -a file`.
 * Excludes safe fd paths (/dev/) and in-place flag (-i, handled separately).
 * Flags accepted before filename: -a (append), -p (ignore SIGPIPE), combined forms like -ap.
 */
export const SHELL_TEE_PIPE_WRITE_RE = /\|\s*tee\s+(?:-[a-zA-Z]+\s+)*(?!\/dev\/)(?!\s*-)/

/**
 * Matches process-substitution writes: `cmd > >(tee file)`.
 * Bash process substitution `>(cmd)` used as a redirect target to write to a file via tee.
 * Excludes /dev/ paths.
 */
export const SHELL_PROC_SUB_WRITE_RE = />\s*>\s*\(\s*tee\s+(?!\/dev\/)/

/**
 * Matches here-string redirects to files: `cmd <<< "text" > file`.
 * Detects `<<<` (here-string) combined with a file redirect (not fd-to-fd, not /dev/).
 */
export const SHELL_HERESTRING_REDIRECT_RE = /<<<[^|&;]*>(?!\s*[&>])(?!\s*\/dev\/)/

/**
 * Matches input process substitution: `cmd < <(subcmd)`.
 * The first `<` is not preceded by another `<` (to avoid matching `<<` heredoc or `<<<` herestring).
 * This construct can be used to feed file-writing side-effects (e.g. `< <(tee file)`) past
 * redirect-only guards, since the write is buried inside the substitution.
 */
export const SHELL_PROCESS_SUBSTITUTION_INPUT_RE = /(?<![<])<\s*<\s*\(/

/**
 * Matches brace-group command redirects: `{cmd1;cmd2} > file` and `{ cmd; } >> file`.
 * A `{...}` grouped command followed by a file redirect (not fd-to-fd, not /dev/).
 * Excludes `${VAR}` parameter expansions via negative lookbehind for `$`.
 */
export const SHELL_BRACE_EXPANSION_WRITE_RE = /(?<!\$)\{[^}]*\}\s*>>?(?!\s*\/dev\/)(?!\s*[&>])/

/** Matches shell statement boundaries split by newline, `;`, `&&`, or `||`. */
export const SHELL_STATEMENT_BOUNDARY = String.raw`(?:^|\n|;|&&|\|\|)`

/** Matches shell segment boundaries split by `|`, `;`, or `&`. */
export const SHELL_SEGMENT_BOUNDARY = `(?:^|[|;&])`

/** Matches boundaries suitable for whole-command token checks. */
export const SHELL_TOKEN_BOUNDARY = String.raw`(?:^|\s|&&|\|\||;)`

export function shellStatementCommandRe(pattern: string, flags = ""): RegExp {
  return new RegExp(`${SHELL_STATEMENT_BOUNDARY}\\s*${pattern}`, flags)
}

export function shellSegmentCommandRe(pattern: string, flags = ""): RegExp {
  return new RegExp(`${SHELL_SEGMENT_BOUNDARY}\\s*${pattern}`, flags)
}

export function shellTokenCommandRe(pattern: string, flags = ""): RegExp {
  return new RegExp(`${SHELL_TOKEN_BOUNDARY}${pattern}`, flags)
}
