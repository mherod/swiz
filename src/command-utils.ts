// ─── Shell command normalisation utilities ──────────────────────────────────
//
// Pure functions for normalising and transforming shell command strings.
// Used by transcript-summary parsing and hook scripts that inspect Bash tool
// calls. Extracted from hooks/hook-utils.ts (issue #84).

import {
  type ParsedGitInvocationTokens,
  parseGitInvocationTokens,
  splitShellSegments,
  tokenizeShellSegment,
} from "./utils/shell-patterns.ts"

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

export type NonCanonicalGitInvocationKind =
  | "binary-path"
  | "command-wrapper"
  | "nested-shell"
  | "shell-substitution"

export interface NonCanonicalGitInvocation {
  kind: NonCanonicalGitInvocationKind
  invocation: string
}

type GitInvocation =
  | NonCanonicalGitInvocation
  | {
      kind: "canonical"
      invocation: string
    }

const MAX_GIT_INVOCATION_DEPTH = 5
const SHELL_EXECUTABLES = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"])
const GIT_COMMAND_WRAPPERS = new Set([
  "!",
  "{",
  "builtin",
  "chronic",
  "command",
  "do",
  "doas",
  "env",
  "exec",
  "if",
  "ionice",
  "nice",
  "nohup",
  "parallel",
  "stdbuf",
  "sudo",
  "then",
  "time",
  "timeout",
  "until",
  "watch",
  "while",
  "xargs",
  "xcrun",
])
const SHELL_SUBCOMMAND_RE = /(?:\$\(|[<>]\()([^()]*)\)|`([^`]*)`/g
const SHELL_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/

// ─── Read-only git classification for substitution bodies ───────────────────
// Reading repo state inside $(...) is ubiquitous in scripts and skill
// preambles (`BRANCH=$(git branch --show-current)`); only mutating git needs
// the canonical statement-boundary form that command-profile matchers can see.

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  "blame",
  "cat-file",
  "describe",
  "diff",
  "for-each-ref",
  "log",
  "ls-files",
  "ls-remote",
  "merge-base",
  "reflog",
  "rev-list",
  "rev-parse",
  "shortlog",
  "show",
  "status",
  "symbolic-ref",
])
const GIT_CONFIG_READ_FLAGS = new Set(["--get", "--get-all", "--get-regexp", "--list", "-l"])
const GIT_CONFIG_WRITE_FLAGS = new Set([
  "--add",
  "--edit",
  "-e",
  "--remove-section",
  "--rename-section",
  "--replace-all",
  "--unset",
  "--unset-all",
])
const GIT_BRANCH_MUTATION_FLAGS = new Set([
  "-C",
  "-c",
  "-D",
  "-d",
  "--delete",
  "--copy",
  "--edit-description",
  "-f",
  "--force",
  "-M",
  "-m",
  "--move",
  "--unset-upstream",
])
const SHELL_REDIRECT_TOKEN_RE = /^\d*[<>]/

function isReadOnlyGitConfigArgs(args: string[]): boolean {
  if (args.some((arg) => GIT_CONFIG_WRITE_FLAGS.has(arg))) return false
  if (args.some((arg) => GIT_CONFIG_READ_FLAGS.has(arg))) return true
  // `git config user.name` reads; `git config user.name value` writes.
  const positionals = args.filter(
    (arg) => !arg.startsWith("-") && !SHELL_REDIRECT_TOKEN_RE.test(arg)
  )
  return positionals.length <= 1
}

function isReadOnlyGitBranchArgs(args: string[]): boolean {
  return args.every(
    (arg) =>
      arg.startsWith("-") &&
      !GIT_BRANCH_MUTATION_FLAGS.has(arg) &&
      !arg.startsWith("--set-upstream-to")
  )
}

function isReadOnlyGitInvocation(invocation: ParsedGitInvocationTokens): boolean {
  const { subcommand, args } = invocation
  if (READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)) return true
  if (subcommand === "branch") return isReadOnlyGitBranchArgs(args)
  if (subcommand === "remote") {
    return args.length === 0 || ["-v", "get-url", "show"].includes(args[0] ?? "")
  }
  if (subcommand === "stash") return args[0] === "list" || args[0] === "show"
  if (subcommand === "config") return isReadOnlyGitConfigArgs(args)
  return false
}

/** True when every direct git use inside a substitution body is read-only. */
function isReadOnlyGitSubstitutionBody(body: string): boolean {
  return splitShellSegments(body).every((segment) => {
    const parsed = parseGitInvocationTokens(segment)
    return parsed === null || isReadOnlyGitInvocation(parsed)
  })
}

function executableBasename(token: string): string {
  return token.slice(token.lastIndexOf("/") + 1)
}

function gitTokenKind(token: string): "canonical" | "binary-path" | null {
  if (token === "git") return "canonical"
  return executableBasename(token) === "git" ? "binary-path" : null
}

function maskSingleQuotedStrings(command: string): string {
  return command.replace(/'[^']*'/g, (match) => " ".repeat(match.length))
}

export function extractExecutableSubcommands(command: string): string[] {
  const subcommands: string[] = []
  const executableText = maskSingleQuotedStrings(command)
  for (const match of executableText.matchAll(SHELL_SUBCOMMAND_RE)) {
    const body = match[1] ?? match[2]
    if (body?.trim()) subcommands.push(body)
  }
  return subcommands
}

function shellCommandBody(tokens: string[]): string | null {
  for (let index = 1; index < tokens.length; index++) {
    const token = tokens[index]!
    if (token === "--command") return tokens[index + 1] ?? null
    if (token.startsWith("--command=")) return token.slice("--command=".length) || null
    if (/^-[^-]*c/.test(token)) return tokens[index + 1] ?? null
  }
  return null
}

function firstGitToken(tokens: string[], start: number): string | null {
  for (let index = start; index < tokens.length; index++) {
    const token = tokens[index]!.replace(/^[({]+/, "").replace(/[)}]+$/, "")
    if (gitTokenKind(token)) return token
  }
  return null
}

function leadingAssignmentCount(tokens: string[]): number {
  let count = 0
  while (count < tokens.length && SHELL_ASSIGNMENT_RE.test(tokens[count]!)) count++
  return count
}

function collectShellWrapperUsage(
  tokens: string[],
  depth: number
): NonCanonicalGitInvocation | null {
  const body = shellCommandBody(tokens)
  if (!body) return null
  const innerUsages = collectGitInvocations(body, depth + 1)
  if (innerUsages.length === 0) return null
  return { kind: "nested-shell", invocation: body }
}

function directGitUsage(firstToken: string): GitInvocation | null {
  const directKind = gitTokenKind(firstToken)
  if (directKind === "canonical") return { kind: "canonical", invocation: firstToken }
  if (directKind === "binary-path") return { kind: "binary-path", invocation: firstToken }
  return null
}

function assignmentGitUsage(tokens: string[]): NonCanonicalGitInvocation | null {
  const assignmentCount = leadingAssignmentCount(tokens)
  if (assignmentCount === 0) return null
  const gitToken = firstGitToken(tokens, assignmentCount)
  return gitToken ? { kind: "command-wrapper", invocation: gitToken } : null
}

function groupedGitUsage(firstToken: string): NonCanonicalGitInvocation | null {
  const normalizedFirst = firstToken.replace(/^[({]+/, "")
  if (normalizedFirst === firstToken || !gitTokenKind(normalizedFirst)) return null
  return { kind: "command-wrapper", invocation: normalizedFirst }
}

function nestedShellUsageInTokens(
  tokens: string[],
  depth: number
): NonCanonicalGitInvocation | null {
  for (let index = 1; index < tokens.length; index++) {
    if (!SHELL_EXECUTABLES.has(executableBasename(tokens[index]!))) continue
    return collectShellWrapperUsage(tokens.slice(index), depth)
  }
  return null
}

function commandWrapperGitUsage(
  tokens: string[],
  firstBasename: string,
  depth: number
): NonCanonicalGitInvocation | null {
  const isWrapper =
    GIT_COMMAND_WRAPPERS.has(firstBasename) ||
    tokens.includes("-exec") ||
    tokens.includes("-execdir")
  if (!isWrapper) return null
  const nestedShell = nestedShellUsageInTokens(tokens, depth)
  if (nestedShell) return nestedShell
  const gitToken = firstGitToken(tokens, 1)
  return gitToken ? { kind: "command-wrapper", invocation: gitToken } : null
}

function collectSegmentGitUsage(segment: string, depth: number): GitInvocation | null {
  const tokens = tokenizeShellSegment(segment)
  if (tokens.length === 0) return null

  const firstToken = tokens[0]!
  const firstBasename = executableBasename(firstToken)
  if (SHELL_EXECUTABLES.has(firstBasename)) return collectShellWrapperUsage(tokens, depth)

  return (
    directGitUsage(firstToken) ??
    assignmentGitUsage(tokens) ??
    groupedGitUsage(firstToken) ??
    commandWrapperGitUsage(tokens, firstBasename, depth)
  )
}

function collectGitInvocations(command: string, depth: number): GitInvocation[] {
  if (depth > MAX_GIT_INVOCATION_DEPTH) return []

  const usages: GitInvocation[] = []
  for (const body of extractExecutableSubcommands(command)) {
    const inner = collectGitInvocations(body, depth + 1)
    if (inner.length === 0) continue
    // Canonical read-only git inside a substitution cannot bypass any
    // command-profile matcher (read subcommands are not gated), so allow it.
    // Wrappers, binary paths, nested shells, and mutating subcommands inside
    // the body still surface as a shell-substitution violation.
    const canonicalReadOnly =
      inner.every((usage) => usage.kind === "canonical") && isReadOnlyGitSubstitutionBody(body)
    if (!canonicalReadOnly) {
      usages.push({ kind: "shell-substitution", invocation: body })
    }
  }

  for (const segment of splitShellSegments(command)) {
    const usage = collectSegmentGitUsage(segment, depth)
    if (usage) usages.push(usage)
  }
  return usages
}

/**
 * Find Git execution that can bypass command-profile matchers.
 *
 * Canonical use means the executable at a top-level shell segment is exactly
 * `git`. Binary paths, environment/command wrappers, nested shells, and shell
 * substitutions are rejected so downstream Git hooks see one stable grammar.
 */
export function findNonCanonicalGitInvocation(command: string): NonCanonicalGitInvocation | null {
  const usages = collectGitInvocations(normalizeCommand(command).normalize("NFKC"), 0)
  return (
    usages.find((usage): usage is NonCanonicalGitInvocation => usage.kind !== "canonical") ?? null
  )
}
