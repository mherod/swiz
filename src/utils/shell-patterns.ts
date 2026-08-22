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

type ShellQuote = '"' | "'" | null

interface SegmentSplitState {
  segments: string[]
  current: string
  quote: ShellQuote
}

function previousNonWhitespace(command: string, index: number): string | undefined {
  for (let i = index - 1; i >= 0; i--) {
    const ch = command[i]
    if (ch !== " " && ch !== "\t") return ch
  }
  return undefined
}

function pushShellSegment(state: SegmentSplitState): void {
  const trimmed = state.current.trim()
  if (trimmed) state.segments.push(trimmed)
  state.current = ""
}

function appendQuotedChar(state: SegmentSplitState, command: string, index: number): number {
  const ch = command[index]!
  state.current += ch

  if (state.quote === '"' && ch === "\\" && index + 1 < command.length) {
    state.current += command[++index]!
  } else if (ch === state.quote) {
    state.quote = null
  }

  return index
}

function consumeSegmentBoundary(
  state: SegmentSplitState,
  command: string,
  index: number
): number | null {
  const ch = command[index]!
  if (ch === ";" || ch === "\n") {
    pushShellSegment(state)
    return index
  }
  if (ch === "|") {
    pushShellSegment(state)
    return command[index + 1] === "|" ? index + 1 : index
  }
  if (ch === "&" && previousNonWhitespace(command, index) !== ">") {
    pushShellSegment(state)
    return command[index + 1] === "&" ? index + 1 : index
  }
  return null
}

function appendUnquotedChar(state: SegmentSplitState, command: string, index: number): number {
  const ch = command[index]!
  if (ch === '"' || ch === "'") {
    state.quote = ch
  } else if (ch === "\\" && index + 1 < command.length) {
    state.current += ch + command[++index]!
    return index
  } else {
    const boundaryIndex = consumeSegmentBoundary(state, command, index)
    if (boundaryIndex !== null) return boundaryIndex
  }

  state.current += ch
  return index
}

/**
 * Characters that never need quoting as a POSIX shell word. A leading "-"
 * (option-like) or "=" (zsh =cmd expansion) forces quoting even though the
 * characters are otherwise safe mid-word.
 */
const SHELL_SAFE_ARG_RE = /^(?![=-])[A-Za-z0-9._/@%+=:,-]+$/

/**
 * Quote a value for safe copy-paste as a single POSIX shell argument.
 *
 * Single quotes neutralize every metacharacter — including `$`, backticks, and
 * `!` — which double quotes do NOT (a filename like `a$(cmd).ts` still
 * command-substitutes inside double quotes). Values made only of safe
 * characters pass through bare so common paths stay readable.
 */
export function quotePosixShellArg(value: string): string {
  if (value.length > 0 && SHELL_SAFE_ARG_RE.test(value)) return value
  return `'${value.replaceAll("'", "'\\''")}'`
}

/**
 * Split a shell command into executable segments at unquoted separators.
 *
 * Separators are `|`, `||`, `;`, newline, `&`, and `&&`. Quoted separators are
 * preserved as argument text. File descriptor redirects like `2>&1` stay in the
 * surrounding segment rather than splitting on `&`.
 */
export function splitShellSegments(command: string): string[] {
  const state: SegmentSplitState = { segments: [], current: "", quote: null }

  for (let i = 0; i < command.length; i++) {
    i = state.quote ? appendQuotedChar(state, command, i) : appendUnquotedChar(state, command, i)
  }

  pushShellSegment(state)
  return state.segments
}

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
 * `--namespace <ns>`, `--config-env <name>=<envvar>`, and flags like `--bare`,
 * `--no-pager`, `-P`, etc. Value-taking options consume the next
 * whitespace-delimited token as well.
 */
export const GIT_GLOBAL_OPTS = String.raw`(?:(?:-[Cc]\s+\S+|--(?:git-dir|work-tree|namespace|config-env)(?:=\S+|\s+\S+)|--?\S+)\s+)*`

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
const _GIT_VALUE_OPTS = new Set([
  "-C",
  "-c",
  "--work-tree",
  "--git-dir",
  "--namespace",
  "--config-env",
])

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

/** Tokenize one shell segment while preserving quoted argument contents. */
export function tokenizeShellSegment(segment: string): string[] {
  return _tokenize(segment)
}

function _skipGitOpts(tokens: string[], i: number): number {
  while (i < tokens.length && tokens[i]!.startsWith("-")) {
    if (_GIT_VALUE_OPTS.has(tokens[i]!)) i++
    i++
  }
  return i
}

interface _ParsedGitInvocation {
  subcommand: string
  args: string[]
}

function _commandStart(tokens: string[], command: string): number | null {
  let index = 0
  if (tokens[index] === "command") index++
  return tokens[index] === command ? index : null
}

function _parseGitInvocation(segment: string): _ParsedGitInvocation | null {
  const tokens = _tokenize(segment)
  const gitIndex = _commandStart(tokens, "git")
  if (gitIndex === null) return null

  const subcommandIndex = _skipGitOpts(tokens, gitIndex + 1)
  const subcommand = tokens[subcommandIndex]
  if (!subcommand) return null
  return { subcommand, args: tokens.slice(subcommandIndex + 1) }
}

export interface ParsedGitInvocationTokens {
  subcommand: string
  args: string[]
}

/**
 * Parse `git [global-opts] <subcommand> <args>` from one shell segment.
 * Returns null when the segment is not a direct git invocation.
 */
export function parseGitInvocationTokens(segment: string): ParsedGitInvocationTokens | null {
  return _parseGitInvocation(segment)
}

function _gitInvocations(command: string): _ParsedGitInvocation[] {
  const invocations: _ParsedGitInvocation[] = []
  for (const segment of splitShellSegments(command)) {
    const parsed = _parseGitInvocation(segment)
    if (parsed) invocations.push(parsed)
  }
  return invocations
}

function _argsBeforeDoubleDash(args: string[]): string[] {
  const separatorIndex = args.indexOf("--")
  return separatorIndex === -1 ? args : args.slice(0, separatorIndex)
}

function _hasLongFlag(args: string[], flag: string): boolean {
  return _argsBeforeDoubleDash(args).some((arg) => arg === flag || arg.startsWith(`${flag}=`))
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
  const parsed = _parseGitInvocation(segment)
  return parsed?.subcommand === "push" && _checkPushTokens(parsed.args, 0)
}

/**
 * Token-based detection of force flags in a `git push` command.
 * Handles `git push -- --force` (refspec, not flag), `-C /path push -f`, etc.
 */
export function hasGitPushForceFlag(command: string): boolean {
  for (const segment of splitShellSegments(command)) {
    if (_checkSegmentForForce(segment)) return true
  }
  return false
}

function _isUnsafeForceToken(token: string): boolean {
  if (token === "--force") return true
  return token.startsWith("-") && !token.startsWith("--") && token.slice(1).includes("f")
}

/** Detect an unsafe `--force`/`-f` on `git push`, excluding lease-based safety flags. */
export function hasUnsafeGitPushForceFlag(command: string): boolean {
  return _gitInvocations(command).some(
    ({ subcommand, args }) =>
      subcommand === "push" && _argsBeforeDoubleDash(args).some(_isUnsafeForceToken)
  )
}

/** Detect any `git stash` invocation except the read-only `list` and `show` forms. */
export function hasGitStashMutation(command: string): boolean {
  return _gitInvocations(command).some(
    ({ subcommand, args }) => subcommand === "stash" && args[0] !== "list" && args[0] !== "show"
  )
}

/** Detect `--no-verify` on the commit and push subcommands where it bypasses hooks. */
export function hasGitNoVerifyFlag(command: string): boolean {
  return _gitInvocations(command).some(
    ({ subcommand, args }) =>
      (subcommand === "commit" || subcommand === "push") && _hasLongFlag(args, "--no-verify")
  )
}

/** Detect Git's trailer injection flag before the `--` argument separator. */
export function hasGitTrailerFlag(command: string): boolean {
  return _gitInvocations(command).some(({ args }) => _hasLongFlag(args, "--trailer"))
}

function _collectCommitMessages(args: string[]): string[] {
  const messages: string[] = []
  const commandArgs = _argsBeforeDoubleDash(args)

  for (let index = 0; index < commandArgs.length; index++) {
    const arg = commandArgs[index]!
    if (arg === "-m" || arg === "--message") {
      const value = commandArgs[++index]
      if (value !== undefined) messages.push(value)
      continue
    }
    if (arg.startsWith("--message=")) {
      messages.push(arg.slice("--message=".length))
      continue
    }
    const shortMessage = arg.match(/^-[^-]*m(.*)$/)
    if (!shortMessage) continue
    const inlineValue = shortMessage[1]
    if (inlineValue) {
      messages.push(inlineValue)
    } else {
      const value = commandArgs[++index]
      if (value !== undefined) messages.push(value)
    }
  }

  return messages
}

export type GitCommitAttribution = "co-author" | "claude-code"

/** Find prohibited attribution in inline `git commit` message arguments. */
export function findGitCommitAttribution(command: string): GitCommitAttribution | null {
  for (const { subcommand, args } of _gitInvocations(command)) {
    if (subcommand !== "commit") continue
    const message = _collectCommitMessages(args).join("\n\n")
    if (/co-authored-by:/i.test(message)) return "co-author"
    if (/generated[\s\S]*with[\s\S]*claude[\s\S]*code/i.test(message)) return "claude-code"
  }
  return null
}

/** Detect a flag on a real `gh` invocation, ignoring quoted examples and args after `--`. */
export function hasGhFlag(command: string, flag: string): boolean {
  for (const segment of splitShellSegments(command)) {
    const tokens = _tokenize(segment)
    const ghIndex = _commandStart(tokens, "gh")
    if (ghIndex === null) continue
    if (_hasLongFlag(tokens.slice(ghIndex + 1), flag)) return true
  }
  return false
}
