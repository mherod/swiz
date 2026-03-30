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

/**
 * Strip quoted shell string contents before pattern matching command tokens.
 *
 * By default the quoted spans are removed entirely. Set `preserveQuotePairs`
 * when callers need to retain empty quotes so token spacing stays stable.
 */
export function stripQuotedShellStrings(
  command: string,
  options: {
    preserveQuotePairs?: boolean
    stripBackticks?: boolean
  } = {}
): string {
  const { preserveQuotePairs = false, stripBackticks = false } = options

  let stripped = preserveQuotePairs
    ? command.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/'[^']*'/g, "''")
    : command.replace(/"(?:[^"\\]|\\.)*"/g, "").replace(/'[^']*'/g, "")

  if (stripBackticks) {
    stripped = stripped.replace(/`[^`]*`/g, preserveQuotePairs ? "``" : "")
  }

  return stripped
}

/** Escape special regex characters in a literal string for use in `new RegExp()`. */
export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export function shellStatementCommandRe(pattern: string, flags = ""): RegExp {
  return new RegExp(`${SHELL_STATEMENT_BOUNDARY}\\s*${pattern}`, flags)
}

export function shellSegmentCommandRe(pattern: string, flags = ""): RegExp {
  return new RegExp(`${SHELL_SEGMENT_BOUNDARY}\\s*${pattern}`, flags)
}

export function shellTokenCommandRe(pattern: string, flags = ""): RegExp {
  return new RegExp(`${SHELL_TOKEN_BOUNDARY}${pattern}`, flags)
}

/**
 * Optional git global options that may appear between `git` and the subcommand.
 * Handles: `-C <dir>`, `-c <key>=<val>`, `--git-dir <path>`, `--work-tree <path>`,
 * `--namespace <ns>`, and short flags like `--bare`, `--no-pager`, `-P`, etc.
 * Value-taking options (`-C`, `-c`, `--git-dir`, `--work-tree`, `--namespace`)
 * consume the next whitespace-delimited token as well.
 */
export const GIT_GLOBAL_OPTS = String.raw`(?:(?:-[Cc]\s+\S+|--(?:git-dir|work-tree|namespace)(?:=\S+|\s+\S+)|--?\S+)\s+)*`

/**
 * Build a regex that matches `git [global-opts] <subcmd>` at a shell statement boundary.
 * Use instead of `shellStatementCommandRe("git\\s+...")` so that commands like
 * `git -C /dir push` are recognised alongside plain `git push`.
 */
export function gitSubcommandRe(subcmd: string, flags = ""): RegExp {
  return shellStatementCommandRe(`git\\s+${GIT_GLOBAL_OPTS}${subcmd}`, flags)
}

// ── Git push / commit regex shortcuts ────────────────────────────────────────

/** Matches `git [opts] push` anywhere in a shell command string. */
export const GIT_PUSH_RE = gitSubcommandRe("push\\b")
/** Matches `git push --delete` or `git push origin :branch` (remote branch deletion, not a code push). */
export const GIT_PUSH_DELETE_RE = gitSubcommandRe("push\\b.*?(--delete\\b|\\s:[^\\s])")
/** Matches `git [opts] commit` anywhere in a shell command string. */
export const GIT_COMMIT_RE = gitSubcommandRe("commit\\b")

// ── Token-based git push force-flag detection ─────────────────────────────────

const _FORCE_LONG_FLAGS = new Set(["--force", "--force-with-lease", "--force-if-includes"])
const _GIT_VALUE_OPTS = new Set(["-C", "-c", "--work-tree", "--git-dir", "--namespace"])

function _isForceToken(token: string): boolean {
  if (!token.startsWith("-")) return false
  if (token.startsWith("--")) {
    const name = token.includes("=") ? token.slice(0, token.indexOf("=")) : token
    return _FORCE_LONG_FLAGS.has(name)
  }
  return token.slice(1).includes("f")
}

interface _TokState {
  tokens: string[]
  token: string
  quote: '"' | "'" | null
}

function _procQuoted(state: _TokState, ch: string): void {
  if (ch === state.quote) state.quote = null
  else state.token += ch
}

function _procUnquoted(state: _TokState, ch: string, seg: string, i: number): number {
  if (ch === '"' || ch === "'") {
    state.quote = ch
  } else if (ch === "\\" && i + 1 < seg.length) {
    state.token += seg[++i]!
  } else if (ch === " " || ch === "\t") {
    if (state.token) {
      state.tokens.push(state.token)
      state.token = ""
    }
  } else {
    state.token += ch
  }
  return i
}

function _tokenize(segment: string): string[] {
  const state: _TokState = { tokens: [], token: "", quote: null }
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]!
    if (state.quote) _procQuoted(state, ch)
    else i = _procUnquoted(state, ch, segment, i)
  }
  if (state.token) state.tokens.push(state.token)
  return state.tokens
}

function _skipGitOpts(tokens: string[], i: number): number {
  while (i < tokens.length && tokens[i]!.startsWith("-")) {
    if (_GIT_VALUE_OPTS.has(tokens[i]!)) i++
    i++
  }
  return i
}

function _checkPushTokens(tokens: string[], i: number): boolean {
  while (i < tokens.length) {
    const t = tokens[i]!
    i++
    if (t === "--") return false
    if (_isForceToken(t)) return true
  }
  return false
}

function _checkSegmentForForce(segment: string): boolean {
  const tokens = _tokenize(segment)
  let i = 0
  while (i < tokens.length) {
    if (tokens[i] !== "git") {
      i++
      continue
    }
    i++
    i = _skipGitOpts(tokens, i)
    if (tokens[i] !== "push") continue
    i++
    if (_checkPushTokens(tokens, i)) return true
  }
  return false
}

/**
 * Token-based detection of force flags in a `git push` command.
 * Handles `git push -- --force` (refspec, not flag), `-C /path push -f`, etc.
 */
export function hasGitPushForceFlag(command: string): boolean {
  const segments = command
    .split(/&&|\|\||;|\n/)
    .map((s) => s.trim())
    .filter(Boolean)
  for (const segment of segments) {
    if (_checkSegmentForForce(segment)) return true
  }
  return false
}
