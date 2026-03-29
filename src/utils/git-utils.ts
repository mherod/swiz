// Git command regexes, argument parsing, and status utilities for hook scripts.

import { git } from "../git-helpers.ts"
import { readProjectSettings } from "../settings.ts"
import {
  GIT_GLOBAL_OPTS,
  gitSubcommandRe,
  shellStatementCommandRe,
  shellTokenCommandRe,
} from "./shell-patterns.ts"

// ── Branch utilities ──────────────────────────────────────────────────────────

/** True if branch matches the configured default branch. */
export function isDefaultBranch(
  branch: string,
  defaultBranches: string | readonly string[] = ["main", "master"]
): boolean {
  const candidates = Array.isArray(defaultBranches) ? defaultBranches : [defaultBranches]
  return candidates.includes(branch)
}

/**
 * Resolve the effective default branch for a repository.
 * Precedence:
 *   1. Project setting `.swiz/config.json` → `defaultBranch`
 *   2. Git remote HEAD (`refs/remotes/origin/HEAD`)
 *   3. Local `main` branch
 *   4. Local `master` branch
 *   5. Fallback `main`
 */
export async function getDefaultBranch(cwd: string): Promise<string> {
  const projectSettings = await readProjectSettings(cwd)
  const configured = projectSettings?.defaultBranch?.trim()
  if (configured) return configured

  try {
    const remoteHeadRef = await git(["symbolic-ref", "refs/remotes/origin/HEAD"], cwd)
    const remoteHead = remoteHeadRef.replace(/^refs\/remotes\/origin\//, "").trim()
    if (remoteHead) return remoteHead
  } catch {
    // Fallback to local branches when origin/HEAD is unavailable.
  }

  try {
    const localMain = await git(["rev-parse", "--verify", "refs/heads/main"], cwd)
    if (localMain) return "main"
  } catch {
    // continue fallback
  }

  try {
    const localMaster = await git(["rev-parse", "--verify", "refs/heads/master"], cwd)
    if (localMaster) return "master"
  } catch {
    // continue fallback
  }

  return "main"
}

// ── Git status parsing ────────────────────────────────────────────────────────

export interface GitStatusCounts {
  total: number
  modified: number
  added: number
  deleted: number
  untracked: number
  lines: string[]
}

/** Parse `git status --porcelain` output into a breakdown of file counts. */
export function parseGitStatus(porcelain: string): GitStatusCounts {
  const lines = porcelain.split("\n").filter((l) => l.trim())
  let modified = 0,
    added = 0,
    deleted = 0,
    untracked = 0
  for (const line of lines) {
    if (line.startsWith(" M")) modified++
    else if (line.startsWith("A ")) added++
    else if (line.startsWith("D ")) deleted++
    else if (line.startsWith("??")) untracked++
  }
  return { total: lines.length, modified, added, deleted, untracked, lines }
}

// ── Git diff --stat summary parsing ──────────────────────────────────────────

export interface GitStatSummary {
  filesChanged: number
  insertions: number
  deletions: number
}

/**
 * Parse the summary line from `git diff --stat` output.
 * Handles all variants: both/insertions-only/deletions-only/rename-only/empty.
 */
export function parseGitStatSummary(statOutput: string): GitStatSummary {
  const lines = statOutput.trim().split("\n")
  const summaryLine = lines.findLast((l) => /\d+\s+files?\s+changed/.test(l)) ?? ""
  if (!summaryLine) return { filesChanged: 0, insertions: 0, deletions: 0 }

  const filesMatch = summaryLine.match(/(\d+)\s+files?\s+changed/)
  const insertMatch = summaryLine.match(/(\d+)\s+insertions?\(\+\)/)
  const deleteMatch = summaryLine.match(/(\d+)\s+deletions?\(-\)/)

  return {
    filesChanged: filesMatch ? parseInt(filesMatch[1]!, 10) : 0,
    insertions: insertMatch ? parseInt(insertMatch[1]!, 10) : 0,
    deletions: deleteMatch ? parseInt(deleteMatch[1]!, 10) : 0,
  }
}

export interface ChangeScopeResult {
  /** True when --stat returned zero files but --name-only found changes */
  statParsingFailed: boolean
  isTrivial: boolean
  isSmallFix: boolean
  isDocsOnly: boolean
  scopeDescription: string
  fileCount: number
  totalLinesChanged: number
}

export interface ClassifyChangeScopeOptions {
  trivialMaxFiles?: number
  trivialMaxLines?: number
}

/**
 * Classify a set of changes as trivial, small-fix, docs-only, or non-trivial.
 * Fail-closed: forces non-trivial when stat parsing disagrees with file list.
 */
function describeScopeCategory(
  result: Pick<
    ChangeScopeResult,
    | "statParsingFailed"
    | "isDocsOnly"
    | "isTrivial"
    | "isSmallFix"
    | "fileCount"
    | "totalLinesChanged"
  >,
  changedFileCount: number
): string {
  if (result.statParsingFailed) return `stat-unparseable (${changedFileCount} files detected)`
  if (result.isDocsOnly) return "docs-only"
  if (result.isTrivial) return "trivial"
  if (result.isSmallFix) return "small-fix"
  return `${result.fileCount}-files, ${result.totalLinesChanged}-lines`
}

function checkIsDocsOnly(changedFiles: string[]): boolean {
  const docsOnlyRe =
    /\.(md|txt|rst)$|^(README|CHANGELOG|LICENSE|docs\/)|(\.config\.|\.json|\.yaml|\.yml|\.toml)$/i
  return changedFiles.length > 0 && changedFiles.every((f) => docsOnlyRe.test(f))
}

function checkIsTrivial(opts: {
  statParsingFailed: boolean
  fileCount: number
  trivialMaxFiles: number
  totalLinesChanged: number
  trivialMaxLines: number
  changedFiles: string[]
}): boolean {
  if (opts.statParsingFailed) return false
  if (opts.fileCount > opts.trivialMaxFiles) return false
  if (opts.totalLinesChanged > opts.trivialMaxLines) return false
  return !opts.changedFiles.some((f) => /src\/|lib\/|components\//.test(f))
}

export function classifyChangeScope(
  stat: GitStatSummary,
  changedFiles: string[],
  options: ClassifyChangeScopeOptions = {}
): ChangeScopeResult {
  const { filesChanged: fileCount, insertions, deletions } = stat
  const totalLinesChanged = insertions + deletions
  const trivialMaxFiles = options.trivialMaxFiles ?? 3
  const trivialMaxLines = options.trivialMaxLines ?? 20

  const statParsingFailed = changedFiles.length > 0 && fileCount === 0
  const isDocsOnly = checkIsDocsOnly(changedFiles)
  const isTrivial = checkIsTrivial({
    statParsingFailed,
    fileCount,
    trivialMaxFiles,
    totalLinesChanged,
    trivialMaxLines,
    changedFiles,
  })
  const isSmallFix = !statParsingFailed && fileCount <= 2 && totalLinesChanged <= 30

  const result = {
    statParsingFailed,
    isTrivial,
    isSmallFix,
    isDocsOnly,
    fileCount,
    totalLinesChanged,
  }

  return {
    ...result,
    scopeDescription: describeScopeCategory(result, changedFiles.length),
  }
}

// ── Git ahead/behind ──────────────────────────────────────────────────────────

export async function getGitAheadBehind(
  cwd: string
): Promise<{ ahead: number; behind: number; upstream: string } | null> {
  const upstream = await git(["rev-parse", "--abbrev-ref", "@{upstream}"], cwd)
  if (!upstream) return null
  const ahead = parseInt(await git(["rev-list", "--count", "@{upstream}..HEAD"], cwd), 10)
  const behind = parseInt(await git(["rev-list", "--count", "HEAD..@{upstream}"], cwd), 10)
  if (Number.isNaN(ahead) || Number.isNaN(behind)) return null
  return { ahead, behind, upstream }
}

export interface GitStatusV2 {
  branch: string
  total: number
  modified: number
  added: number
  deleted: number
  untracked: number
  lines: string[]
  ahead: number
  behind: number
  upstream: string | null
  /** True when branch.upstream is set but the remote branch no longer exists (gone). */
  upstreamGone: boolean
}

/**
 * Parse the raw output of `git status --porcelain=v2 --branch` into a GitStatusV2 object.
 * Exported for unit testing — call `getGitStatusV2(cwd)` in production code.
 */
interface BranchInfo {
  branch: string
  ahead: number
  behind: number
  upstream: string | null
  upstreamAbSeen: boolean
}

function parseBranchHeader(line: string, info: BranchInfo): boolean {
  if (line.startsWith("# branch.head ")) {
    const head = line.slice("# branch.head ".length).trim()
    info.branch = head === "(detached)" ? "(detached)" : head
    return true
  }
  if (line.startsWith("# branch.upstream ")) {
    info.upstream = line.slice("# branch.upstream ".length).trim()
    return true
  }
  if (line.startsWith("# branch.ab ")) {
    info.upstreamAbSeen = true
    const match = /\+(\d+)\s+-(\d+)/.exec(line)
    if (match) {
      info.ahead = Number(match[1])
      info.behind = Number(match[2])
    }
    return true
  }
  return false
}

interface FileCounts {
  modified: number
  added: number
  deleted: number
  untracked: number
}

function parseXYStatus(xy: string, counts: FileCounts): void {
  if (xy[0] === "D") counts.deleted++
  else if (xy[0] === "A") counts.added++
  else if (xy[0] !== ".") counts.modified++
  if (xy[1] === "D") counts.deleted++
  else if (xy[1] !== ".") counts.modified++
}

function parseFileEntry(line: string, counts: FileCounts, lines: string[]): void {
  if (line.startsWith("1 ") || line.startsWith("2 ")) {
    const xy = line.split(" ")[1] ?? ".."
    parseXYStatus(xy, counts)
    const path = line.includes("\t") ? line.split("\t").pop()! : line.split(" ").pop()!
    lines.push(path)
  } else if (line.startsWith("? ")) {
    counts.untracked++
    lines.push(line.slice(2))
  }
}

export function parseGitStatusV2Output(out: string): GitStatusV2 | null {
  if (!out) return null

  const info: BranchInfo = {
    branch: "(detached)",
    ahead: 0,
    behind: 0,
    upstream: null,
    upstreamAbSeen: false,
  }
  const counts: FileCounts = { modified: 0, added: 0, deleted: 0, untracked: 0 }
  const lines: string[] = []

  for (const line of out.split("\n")) {
    if (!parseBranchHeader(line, info)) parseFileEntry(line, counts, lines)
  }

  const upstreamGone = info.upstream !== null && !info.upstreamAbSeen
  return {
    branch: info.branch,
    total: lines.length,
    ...counts,
    lines,
    ahead: info.ahead,
    behind: info.behind,
    upstream: info.upstream,
    upstreamGone,
  }
}

/**
 * Run `git status --porcelain=v2 --branch` once and parse branch name,
 * ahead/behind counts, and file-change breakdown. Replaces five separate git calls.
 */
export async function getGitStatusV2(cwd: string): Promise<GitStatusV2 | null> {
  const out = await git(["status", "--porcelain=v2", "--branch"], cwd)
  return parseGitStatusV2Output(out)
}

/** Canonical empty-tree hash used when repos have fewer than N commits. */
export const GIT_EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

export async function recentHeadRange(cwd: string, commitsBack = 10): Promise<string> {
  const base =
    (await git(["rev-parse", "--verify", `HEAD~${Math.max(1, Math.floor(commitsBack))}`], cwd)) ||
    GIT_EMPTY_TREE
  return `${base}..HEAD`
}

// ── Git command regexes ───────────────────────────────────────────────────────
// All GIT_*_RE patterns use gitSubcommandRe() which allows optional global
// options (e.g. `-C <dir>`, `-c key=val`) between `git` and the subcommand.

/** Matches `git [opts] push` anywhere in a shell command string. */
export const GIT_PUSH_RE = gitSubcommandRe("push\\b")
/** Matches `git push --delete` or `git push origin :branch` (remote branch deletion, not a code push). */
export const GIT_PUSH_DELETE_RE = gitSubcommandRe("push\\b.*?(--delete\\b|\\s:[^\\s])")
/** Matches `git [opts] commit` anywhere in a shell command string. */
export const GIT_COMMIT_RE = gitSubcommandRe("commit\\b")

/** Matches git read-only subcommands (with optional global opts). */
export const GIT_READ_RE = gitSubcommandRe(
  "(log|status|diff|show|branch|remote\\b|rev-parse|rev-list|reflog|ls-files|describe|tag\\b)(\\s|$)"
)

/** Matches git subcommands that mutate state (with optional global opts). */
export const GIT_WRITE_RE = new RegExp(
  `\\bgit\\s+${GIT_GLOBAL_OPTS}(add|commit|push|pull|fetch|checkout|switch|restore|reset|rebase|merge|stash\\s+(?!list)|cherry-pick|revert|rm|mv|apply)\\b`
)

/** Matches `git [opts] push|pull|fetch` — mechanical sync ops. */
export const GIT_SYNC_RE = gitSubcommandRe("(push|pull|fetch)\\b")

/** Matches `git [opts] merge` anywhere in a shell command string. */
export const GIT_MERGE_RE = gitSubcommandRe("merge\\b")

/** Matches `gh pr merge` anywhere in a shell command string. */
export const GH_PR_MERGE_RE = shellStatementCommandRe("gh\\s+pr\\s+merge\\b")

/** Matches `gh pr create` anywhere in a shell command string. */
export const GH_PR_CREATE_RE = shellStatementCommandRe("gh\\s+pr\\s+create\\b")

/** Matches `git [opts] checkout` anywhere in a shell command string. */
export const GIT_CHECKOUT_RE = gitSubcommandRe("checkout\\b")

/** Matches `git [opts] switch` anywhere in a shell command string. */
export const GIT_SWITCH_RE = gitSubcommandRe("switch\\b")

/** Matches `gh pr checkout` anywhere in a shell command string. */
export const GH_PR_CHECKOUT_RE = shellStatementCommandRe("gh\\s+pr\\s+checkout\\b")

/** Matches `gh pr review ... --dismiss` anywhere in a shell command string. */
export const GH_PR_REVIEW_DISMISS_RE = /\bgh\s+pr\s+review\b[^|;&]*--dismiss\b/

/** Matches `git [opts] checkout -b` or `git [opts] switch -c` — create new branch. */
export const GIT_CHECKOUT_NEW_BRANCH_RE = gitSubcommandRe(
  "(?:checkout\\s+-[bcB]|switch\\s+-[cC])\\b"
)

/** Matches any `git` invocation in a shell command string. */
export const GIT_ANY_CMD_RE = shellTokenCommandRe("git\\s")

/** Extract the PR number from a `gh pr merge <number>` command. */
export function extractPrNumber(command: string): string | null {
  const match = command.match(/gh\s+pr\s+merge\s+(\d+)/)
  return match?.[1] ?? null
}

/** Extract the branch name from a `git [opts] merge <branch>` command. */
export function extractMergeBranch(command: string): string | null {
  const match = command.match(
    new RegExp(`git\\s+${GIT_GLOBAL_OPTS}merge\\s+(?:--\\S+\\s+)*([^\\s;|&]+)`)
  )
  if (!match?.[1]) return null
  const branch = match[1]
  if (branch.startsWith("-")) return null
  return branch
}

/** Extract the target branch from `git [opts] checkout <branch>` (non -b form). */
export function extractCheckoutBranch(command: string): string | null {
  const match = command.match(
    new RegExp(`\\bgit\\s+${GIT_GLOBAL_OPTS}checkout\\s+(?!-[bcBC](?:\\s|$))([^\\s;|&-][^\\s;|&]*)`)
  )
  return match?.[1] ?? null
}

/** Extract target branch from `git [opts] switch <branch>` (non -c/-C form). */
export function extractSwitchBranch(command: string): string | null {
  const match = command.match(
    new RegExp(`\\bgit\\s+${GIT_GLOBAL_OPTS}switch\\s+(?!-[cC](?:\\s|$))([^\\s;|&-][^\\s;|&]*)`)
  )
  return match?.[1] ?? null
}

/** Extract the start-point from `git [opts] checkout -b <new> [start]` or `git [opts] switch -c <new> [start]`. */
export function extractCheckoutStartPoint(command: string): string | null {
  const checkoutMatch = command.match(
    new RegExp(
      `\\bgit\\s+${GIT_GLOBAL_OPTS}checkout\\s+-[bB]\\s+[^\\s;|&]+(?:\\s+([^\\s;|&-][^\\s;|&]*))?`
    )
  )
  if (checkoutMatch?.[1]) return checkoutMatch[1]

  const switchMatch = command.match(
    new RegExp(
      `\\bgit\\s+${GIT_GLOBAL_OPTS}switch\\s+-[cC]\\s+[^\\s;|&]+(?:\\s+([^\\s;|&-][^\\s;|&]*))?`
    )
  )
  if (switchMatch?.[1]) return switchMatch[1]

  return null
}

/** Collect all capture-group-1 matches from checkout and switch regex patterns. */
function collectGitRefMatches(
  command: string,
  checkoutPattern: string,
  switchPattern: string
): string[] {
  const results: string[] = []
  for (const m of command.matchAll(new RegExp(checkoutPattern, "g"))) {
    if (m[1]) results.push(m[1])
  }
  for (const m of command.matchAll(new RegExp(switchPattern, "g"))) {
    if (m[1]) results.push(m[1])
  }
  return results
}

/** All new branch names from `checkout -b|-B` / `switch -c|-C` in a compound shell command. */
export function collectCheckoutNewBranchNames(command: string): string[] {
  return collectGitRefMatches(
    command,
    `\\bgit\\s+${GIT_GLOBAL_OPTS}checkout\\s+-[bB]\\s+([^\\s;|&]+)`,
    `\\bgit\\s+${GIT_GLOBAL_OPTS}switch\\s+-[cC]\\s+([^\\s;|&]+)`
  )
}

/**
 * Plain `checkout <ref>` / `switch <ref>` targets (excludes `-b`/`-c` forms), in order.
 */
export function collectPlainCheckoutSwitchTargets(command: string): string[] {
  return collectGitRefMatches(
    command,
    `\\bgit\\s+${GIT_GLOBAL_OPTS}checkout\\s+(?!-[bcBC](?:\\s|$))([^\\s;|&-][^\\s;|&]*)`,
    `\\bgit\\s+${GIT_GLOBAL_OPTS}switch\\s+(?!-[cC](?:\\s|$))([^\\s;|&-][^\\s;|&]*)`
  )
}

/**
 * Extract the first new branch name from `git [opts] checkout -b|-B <name>` or
 * `git [opts] switch -c|-C <name>`.
 */
export function extractCheckoutNewBranchName(command: string): string | null {
  return collectCheckoutNewBranchNames(command)[0] ?? null
}

/**
 * Matches any force-push flag on a `git [opts] push` command:
 *   --force, --force-with-lease, --force-with-lease=<ref>, --force-if-includes, -f
 */
export const FORCE_PUSH_RE = new RegExp(
  `\\bgit\\s+${GIT_GLOBAL_OPTS}push\\b.*(?:--force(?:-with-lease(?:=[^\\s]+)?|-if-includes)?(?!\\S)|-[a-zA-Z]*f)`
)

// ── Token-based git push argument parser ──────────────────────────────────────

const FORCE_LONG_FLAG_NAMES = new Set(["--force", "--force-with-lease", "--force-if-includes"])
const GIT_VALUE_OPTS = new Set(["-C", "-c", "--work-tree", "--git-dir", "--namespace"])

function isGitPushForceToken(token: string): boolean {
  if (!token.startsWith("-")) return false
  if (token.startsWith("--")) {
    const name = token.includes("=") ? token.slice(0, token.indexOf("=")) : token
    return FORCE_LONG_FLAG_NAMES.has(name)
  }
  return token.slice(1).includes("f")
}

interface TokenizerState {
  tokens: string[]
  token: string
  quote: '"' | "'" | null
}

function processQuotedChar(state: TokenizerState, ch: string): void {
  if (ch === state.quote) state.quote = null
  else state.token += ch
}

function processUnquotedChar(
  state: TokenizerState,
  ch: string,
  segment: string,
  i: number
): number {
  if (ch === '"' || ch === "'") {
    state.quote = ch
  } else if (ch === "\\" && i + 1 < segment.length) {
    state.token += segment[++i]!
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

function shellTokenize(segment: string): string[] {
  const state: TokenizerState = { tokens: [], token: "", quote: null }
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]!
    if (state.quote) processQuotedChar(state, ch)
    else i = processUnquotedChar(state, ch, segment, i)
  }
  if (state.token) state.tokens.push(state.token)
  return state.tokens
}

function skipGitGlobalOptions(tokens: string[], i: number): number {
  while (i < tokens.length && tokens[i]!.startsWith("-")) {
    if (GIT_VALUE_OPTS.has(tokens[i]!)) i++
    i++
  }
  return i
}

function checkPushSegmentForForceFlag(tokens: string[], i: number): boolean {
  while (i < tokens.length) {
    const t = tokens[i]!
    i++
    if (t === "--") return false
    if (isGitPushForceToken(t)) return true
  }
  return false
}

function checkSegmentForPushForceFlag(segment: string): boolean {
  const tokens = shellTokenize(segment)
  let i = 0

  while (i < tokens.length) {
    if (tokens[i] !== "git") {
      i++
      continue
    }
    i++

    i = skipGitGlobalOptions(tokens, i)
    if (tokens[i] !== "push") continue
    i++

    if (checkPushSegmentForForceFlag(tokens, i)) return true
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
    if (checkSegmentForPushForceFlag(segment)) return true
  }
  return false
}

/** Matches `ls`, `rg`, or `grep` — pure read commands. */
export const READ_CMD_RE = shellStatementCommandRe("(ls|rg|grep)\\b")

/** Matches diagnostic/cleanup commands recommended by other hooks (e.g., index-lock recovery). */
export const RECOVERY_CMD_RE = shellStatementCommandRe("(ps|lsof|trash|wc)\\b")

/** Matches setup, install, lint, build, format, test, and typecheck commands — safe to run without tasks. */
export const SETUP_CMD_RE = shellStatementCommandRe(
  "(bun|pnpm|npm|yarn|npx)\\s+(?:run\\s+)?(install|add|i|ci|lint|lint-staged|build|format|test|typecheck|type-check|check|biome|eslint|prettier|tsc)\\b"
)

/** Matches any `gh` CLI invocation. */
export const GH_CMD_RE = shellStatementCommandRe("gh\\b")

/** Matches `swiz issue close` or `swiz issue comment`. */
export const SWIZ_ISSUE_RE = shellStatementCommandRe("swiz\\s+issue\\s+(close|comment)\\b")

/** Matches CI verification commands. */
export const CI_WAIT_RE = shellStatementCommandRe("(?:swiz|bun\\b[^|;]*)\\s+ci-wait\\b")

/** Matches `git [opts] branch --show-current`. */
export const BRANCH_CHECK_RE = new RegExp(
  `\\bgit\\s+${GIT_GLOBAL_OPTS}branch\\s+--show-current(?!\\S)`
)

/** Matches `gh pr list --head`. */
export const PR_CHECK_RE = /\bgh\s+pr\s+list\b.*--head\b/

// ── GitHub identity helpers ───────────────────────────────────────────────────

import { gh } from "../git-helpers.ts"

export {
  isGitHubHost,
  parseRemoteUrl,
  type RemoteInfo,
} from "../git-helpers.ts"

/**
 * Extract the repository owner login from a git remote URL.
 * Handles both SSH and HTTPS GitHub remote formats.
 */
export function extractOwnerFromUrl(remoteUrl: string): string | null {
  const sshMatch = remoteUrl.match(/git@github\.com:([^/]+)\//)
  if (sshMatch?.[1]) return sshMatch[1]

  const httpsMatch = remoteUrl.match(/github\.com\/([^/]+)\//)
  if (httpsMatch?.[1]) return httpsMatch[1]

  return null
}

/** Return the login of the currently-authenticated GitHub user via `gh api user`. */
export async function getCurrentGitHubUser(cwd: string): Promise<string | null> {
  const login = await gh(["api", "user", "--jq", ".login"], cwd)
  return login || null
}

/** Return the `owner/repo` slug for the GitHub remote at `cwd`. */
export async function getRepoNameWithOwner(cwd: string): Promise<string | null> {
  const name = await gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], cwd)
  return name || null
}

// ── Source file classification ────────────────────────────────────────────────

/** Source file extensions worth scanning for code issues. */
export const SOURCE_EXT_RE =
  /\.(ts|tsx|js|jsx|mjs|cjs|py|rb|go|java|kt|swift|php|cs|cpp|c|rs|vue|svelte)$/

/** Test file pattern — skip these in debug and suppression pattern checks. */
export const TEST_FILE_RE = /\.test\.|\.spec\.|__tests__|\/test\//
