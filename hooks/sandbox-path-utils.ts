import { lstat, realpath } from "node:fs/promises"
import { basename, dirname, join as joinPath, resolve } from "node:path"
import { normalizeCommand, stripHeredocs } from "../src/command-utils.ts"
import { expandHomeVars, getHomeDirOrNull } from "../src/home.ts"
import { isMarkdownPath } from "../src/tool-matchers.ts"
import {
  splitShellSegments,
  stripQuotedShellStrings,
  tokenizeShellSegment,
} from "../src/utils/shell-patterns.ts"

const SAFE_READ_ONLY_COMMANDS = new Set([
  "cat",
  "head",
  "tail",
  "grep",
  "rg",
  "sed",
  "awk",
  "find",
  "ls",
  "stat",
  "wc",
  "shasum",
  "cut",
  "sort",
  "uniq",
  "tr",
])

const SKILL_SCRIPT_RUNNERS = new Set(["bash", "bun", "sh", "zsh"])
const SKILL_PROGRAM_FILE_FLAGS = new Set(["-f", "--from-file"])

export const SAFE_READ_ONLY_INSPECTION_HINT = [
  "If you only need to inspect the file, use Read or a read-only shell command (cat, head, tail, grep, rg, sed -n, awk).",
  "Skill files under configured skill roots (e.g., ~/.agents/skills/, ~/.claude/skills/, ~/.cursor/skills/) are readable with those commands.",
  "Use the local .skills/ copy when the global path is not accessible.",
  "Read-only commands may be joined with && or ; when every segment is read-only; do not append writes, tees, redirects, or command substitution.",
].join(" ")

export const PROTECTED_TASK_STORAGE_HINT = [
  "Task files are managed state and must not be read, edited, or written directly.",
  "Use native task tools only: TaskList/TaskGet for inspection and TaskCreate/TaskUpdate or the current planning surface for changes.",
].join(" ")

const PROTECTED_TASK_STORAGE_RE =
  /(?:^|[/\\])\.(?:claude|codex|gemini|cursor)[/\\]tasks(?:[/\\]|[*{[]|$)/i

export function isProtectedTaskStoragePath(target: string): boolean {
  return PROTECTED_TASK_STORAGE_RE.test(target.normalize("NFKC").replace(/\\/g, "/"))
}

/**
 * Resolve a single file path through home-var expansion and symlink
 * canonicalization, then run the protected-task-storage check on every form.
 *
 * The pure-textual {@link isProtectedTaskStoragePath} misses indirection: a
 * `file_path` like `/tmp/link/1.json` whose parent symlinks into the tasks dir,
 * or a `${HOME}/.claude/tasks/...` form, has no literal `.../tasks` segment to
 * match until it is expanded and run through `realpath`. This resolver closes
 * both for the single-path tools (Edit/Write/Read/Glob/LS). It is intentionally
 * not used for Bash command strings, which are not single resolvable paths.
 */
export async function isProtectedTaskStoragePathResolved(filePath: string): Promise<boolean> {
  if (!filePath) return false
  if (isProtectedTaskStoragePath(filePath)) return true

  const home = getHomeDirOrNull()
  const expanded = home ? expandHomeVars(filePath, home) : filePath
  if (expanded !== filePath && isProtectedTaskStoragePath(expanded)) return true

  try {
    const canonical = await resolveCanonical(expanded)
    if (isProtectedTaskStoragePath(canonical)) return true
  } catch {
    // realpath resolution failed (glob metacharacters, unreadable parent, etc.);
    // the textual checks above already ran, so there is nothing more to resolve.
  }
  return false
}

// Persisted tool-result / output files for the current session live under
// ~/.<agent>/projects/<key>/<session>/tool-results/. The harness writes a tool's
// stdout there when it is too large to inline, and the agent legitimately needs
// to read it back (cat/tail/grep). Such paths are the agent's own session output,
// not protected config or task state, so they are exempt from the hidden-home
// shell-path block — reads and writes here cannot bypass any sandbox protection.
const SESSION_TOOL_RESULTS_RE =
  /[/\\]\.(?:claude|codex|gemini|cursor)[/\\]projects[/\\].+[/\\]tool-results(?:[/\\]|$)/i

export function isSessionToolResultsPath(target: string): boolean {
  return SESSION_TOOL_RESULTS_RE.test(target.normalize("NFKC").replace(/\\/g, "/"))
}

export function buildProtectedTaskStorageDenyReason(attemptedPath: string): string {
  return [
    "Task file access is blocked.",
    "",
    `Attempted path: ${attemptedPath}.`,
    "",
    PROTECTED_TASK_STORAGE_HINT,
  ].join("\n")
}

function sanitizeShellCommand(command: string): string {
  return stripQuotedShellStrings(stripHeredocs(normalizeCommand(command).normalize("NFKC")))
    .replace(/\s+/g, " ")
    .trim()
}

// Benign redirections that never write to an arbitrary file: merging a stream
// into another fd (e.g. `2>&1`) and discarding output to /dev/null (e.g.
// `2>/dev/null`, `&>/dev/null`). These are routine on read-only inspection
// commands such as `ls -la <path> 2>&1 | head`, so they must be stripped before
// the redirect/background rejection below — otherwise the lone `>`/`&` they
// contain would wrongly disqualify an otherwise safe command.
const BENIGN_REDIRECT_RE = /(?:[0-9]*>&[0-9]+)|(?:(?:&|[0-9]+)?>>?\s*\/dev\/null\b)/g

function stripBenignRedirects(command: string): string {
  return command.replace(BENIGN_REDIRECT_RE, " ").replace(/\s+/g, " ").trim()
}

function isSafeSedCommand(stage: string): boolean {
  const tokens = stage.split(/\s+/).filter(Boolean)
  for (const token of tokens.slice(1)) {
    if (token === "--") break
    if (token === "-f" || token.startsWith("--file")) return false
    if (token === "-i" || token.startsWith("-i") || token.startsWith("--in-place")) return false
  }
  return true
}

function hasUnsafeAwkOption(tokens: string[], commandIndex: number): boolean {
  return tokens
    .slice(commandIndex + 1)
    .some(
      (token) =>
        token === "-f" ||
        token.startsWith("--file") ||
        token === "-i" ||
        token.startsWith("-i") ||
        token.startsWith("--in-place")
    )
}

function hasUnsafeAwkProgram(programAndArgs: string): boolean {
  return [
    /\bsystem\s*\(/i,
    /@load\b/i,
    /\|\s*&?\s*getline\b/,
    /\b(?:print|printf)\b[^;}]*?(?:>>?|\|)/,
  ].some((pattern) => pattern.test(programAndArgs))
}

function isSafeAwkCommand(stage: string): boolean {
  const tokens = tokenizeShellSegment(stage)
  const commandIndex = commandTokenIndex(tokens)
  if (tokens[commandIndex] !== "awk") return true
  if (hasUnsafeAwkOption(tokens, commandIndex)) return false
  const programAndArgs = tokens.slice(commandIndex + 1).join(" ")
  return !hasUnsafeAwkProgram(programAndArgs)
}

const UNSAFE_FIND_ACTIONS = [
  "-delete",
  "-exec",
  "-execdir",
  "-fls",
  "-fprint",
  "-fprint0",
  "-fprintf",
  "-ok",
  "-okdir",
]

function isSafeFindCommand(stage: string): boolean {
  const tokens = tokenizeShellSegment(stage)
  const commandIndex = commandTokenIndex(tokens)
  if (tokens[commandIndex] !== "find") return true

  return tokens
    .slice(commandIndex + 1)
    .every(
      (token) =>
        !UNSAFE_FIND_ACTIONS.some((action) => token === action || token.startsWith(`${action}=`))
    )
}

function areAwkCommandsSafe(command: string): boolean {
  return splitShellSegments(command).every(isSafeAwkCommand)
}

function containsUnsafeReadOnlyShellSyntax(command: string): boolean {
  return ["||", ">", "<"].some((token) => command.includes(token))
}

function isSafeReadOnlyPipeline(command: string): boolean {
  const stages = command.split("|").map((stage) => stage.trim())
  if (stages.length === 0 || stages.some((stage) => !stage)) return false

  return stages.every((stage) => {
    const commandName = stage.match(/^[^\s]+/)?.[0] ?? ""
    return (
      SAFE_READ_ONLY_COMMANDS.has(commandName) &&
      (commandName !== "sed" || isSafeSedCommand(stage)) &&
      (commandName !== "find" || isSafeFindCommand(stage))
    )
  })
}

/**
 * Returns true when a shell command is a simple read-only inspection command.
 *
 * The validator is intentionally strict: it only permits direct read commands,
 * pipelines, and `&&`/`;` chains whose every command is read-only. It rejects
 * other shell chaining, redirects, and command substitution.
 */
export function isSafeReadOnlyShellCommand(command: string): boolean {
  if (!command.trim()) return false
  const normalized = command.normalize("NFKC")
  if (normalized.includes("`") || normalized.includes("$(")) return false
  if (!areAwkCommandsSafe(normalized)) return false

  const sanitized = stripBenignRedirects(sanitizeShellCommand(normalized))
  if (!sanitized) return false
  if (containsUnsafeReadOnlyShellSyntax(sanitized)) return false

  const commands = sanitized.split(/&&|;/).map((part) => part.trim())
  if (commands.length === 0 || commands.some((part) => !part)) return false

  return commands.every(
    (readCommand) => !readCommand.includes("&") && isSafeReadOnlyPipeline(readCommand)
  )
}

/**
 * Return true when every use of one Markdown path occurs in a read-only shell
 * segment. Other command segments are intentionally ignored: this guard owns
 * access to the hidden path, not unrelated operations inside the dispatch cwd.
 */
export function isAllowedMarkdownShellReadCommand(command: string, markdownPath: string): boolean {
  if (!command.trim() || !isMarkdownPath(normalizeShellPathToken(markdownPath))) return false
  const normalized = command.normalize("NFKC")
  if (normalized.includes("`") || normalized.includes("$(")) return false

  let matched = false
  for (const segment of splitShellSegments(normalized)) {
    const tokens = tokenizeShellSegment(segment)
    if (!tokens.some((token) => tokenReferencesPath(token, markdownPath))) continue
    matched = true
    if (!isSafeReadOnlyShellCommand(segment)) return false
  }
  return matched
}

function normalizeShellPathToken(token: string): string {
  return token.replace(/^[`"']+|[`"']+$/g, "")
}

export function isPathWithin(parent: string, child: string): boolean {
  const normalizedParent = parent.replace(/\\/g, "/")
  const normalizedChild = child.replace(/\\/g, "/")
  const normalizedPrefix = normalizedParent.endsWith("/")
    ? normalizedParent
    : `${normalizedParent}/`
  return normalizedChild === normalizedParent || normalizedChild.startsWith(normalizedPrefix)
}

const UNSAFE_TRASH_SOURCE_RE = /[*?[\]{}$`<>|;&()\n\r]/

interface TrashMove {
  source: string
  destination: string
}

function parseTrashMove(command: string): TrashMove | null {
  const segments = splitShellSegments(command.normalize("NFKC").trim())
  if (segments.length !== 1) return null

  const tokens = tokenizeShellSegment(segments[0] ?? "")
  if (tokens.length !== 3 || tokens[0] !== "mv") return null

  const source = normalizeShellPathToken(tokens[1] ?? "")
  const destination = normalizeShellPathToken(tokens[2] ?? "")
  if (!source || UNSAFE_TRASH_SOURCE_RE.test(source)) return null
  return { source, destination }
}

function isMovableEntry(source: Awaited<ReturnType<typeof lstat>>): boolean {
  return source.isFile() || source.isDirectory() || source.isSymbolicLink()
}

async function isExistingCwdEntry(source: string, cwd: string): Promise<boolean> {
  const canonicalCwd = await resolveCanonical(cwd)
  const absoluteSource = resolve(canonicalCwd, source)
  const canonicalSource = joinPath(
    await resolveCanonical(dirname(absoluteSource)),
    basename(absoluteSource)
  )
  if (canonicalSource === canonicalCwd || !isPathWithin(canonicalCwd, canonicalSource)) return false

  try {
    return isMovableEntry(await lstat(absoluteSource))
  } catch {
    return false
  }
}

async function isCanonicalTrashRoot(destination: string, homeDir: string): Promise<boolean> {
  if (destination !== "~/.Trash" && destination !== "~/.Trash/") return false
  const canonicalHome = await resolveCanonical(homeDir)
  const expectedTrash = joinPath(canonicalHome, ".Trash")
  return (await resolveCanonical(expectedTrash)) === expectedTrash
}

/**
 * Return true only for a direct, single-source move from the dispatch cwd to
 * the current user's canonical Trash root. The final source component is
 * checked with lstat and deliberately not realpathed, so moving a symlink
 * moves the link itself rather than granting access based on its target.
 */
export async function isAllowedTrashMoveCommand(
  command: string,
  cwd: string,
  homeDir: string
): Promise<boolean> {
  const move = parseTrashMove(command)
  if (!move || !(await isExistingCwdEntry(move.source, cwd))) return false
  return await isCanonicalTrashRoot(move.destination, homeDir)
}

function tokenReferencesPath(token: string, path: string): boolean {
  const normalizedToken = normalizeShellPathToken(token)
  const normalizedPath = normalizeShellPathToken(path)
  return normalizedToken === normalizedPath || normalizedToken.endsWith(`=${normalizedPath}`)
}

function commandTokenIndex(tokens: string[]): number {
  let index = tokens[0] === "command" ? 1 : 0
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index] ?? "")) index++
  return index
}

function isAllowedSkillPathStage(tokens: string[], pathIndexes: number[]): boolean {
  const commandIndex = commandTokenIndex(tokens)
  const commandName = tokens[commandIndex] ?? ""
  if (!commandName || pathIndexes.length !== 1) return false

  const pathIndex = pathIndexes[0]!
  if (pathIndex === commandIndex) return true

  if (SKILL_SCRIPT_RUNNERS.has(commandName)) {
    return tokens.slice(commandIndex + 1, pathIndex).every((token) => {
      return token === "run" || token.startsWith("-")
    })
  }

  if (commandName !== "jq") return false
  const pathToken = tokens[pathIndex]!
  return (
    SKILL_PROGRAM_FILE_FLAGS.has(tokens[pathIndex - 1] ?? "") ||
    pathToken.startsWith("--from-file=")
  )
}

/**
 * Returns true when every use of a shared skill path executes that script or
 * loads it as a jq program. Skill files are trusted user-installed code, but
 * the path must not also appear as a redirect or another command's write target.
 */
export function isAllowedSharedSkillShellCommand(command: string, skillPath: string): boolean {
  if (!command.trim() || !skillPath.trim()) return false
  const normalized = command.normalize("NFKC")
  if (normalized.includes("`") || normalized.includes("$(")) return false

  let matched = false
  for (const segment of splitShellSegments(normalized)) {
    const tokens = tokenizeShellSegment(segment)
    const pathIndexes = tokens.flatMap((token, index) =>
      tokenReferencesPath(token, skillPath) ? [index] : []
    )
    if (pathIndexes.length === 0) continue
    matched = true
    if (!isAllowedSkillPathStage(tokens, pathIndexes)) return false
  }
  return matched
}

export function isSharedAgentsSkillPath(target: string, homeDir: string): boolean {
  const normalizedHome = homeDir.replace(/\\/g, "/").replace(/\/$/, "")
  const normalizedTarget = normalizeShellPathToken(target)
    .replace(/^~(?=\/|$)/, normalizedHome)
    .replace(/^\$HOME(?=\/|$)/, normalizedHome)
    .replace(/^\$\{HOME\}(?=\/|$)/, normalizedHome)
    .replace(/\\/g, "/")
    .replace(/\/$/, "")
  const sharedSkillRoot = `${normalizedHome}/.agents/skills`
  return normalizedTarget === sharedSkillRoot || normalizedTarget.startsWith(`${sharedSkillRoot}/`)
}

export async function resolveCanonical(p: string): Promise<string> {
  const absolute = resolve(p)
  try {
    return await realpath(absolute)
  } catch {
    let dir = dirname(absolute)
    let rest = basename(absolute)
    while (dir !== dirname(dir)) {
      try {
        const realDir = await realpath(dir)
        return joinPath(realDir, rest)
      } catch {
        rest = `${basename(dir)}/${rest}`
        dir = dirname(dir)
      }
    }
    return absolute
  }
}

export function isHiddenTopLevelHomePath(target: string, homeDir: string): boolean {
  const normalizedTarget = target.replace(/\\/g, "/")
  const normalizedHome = homeDir.replace(/\\/g, "/").replace(/\/$/, "")
  if (normalizedTarget === normalizedHome) return false
  if (!normalizedTarget.startsWith(`${normalizedHome}/`)) return false

  const relative = normalizedTarget.slice(normalizedHome.length + 1)
  const firstSegment = relative.split("/")[0] ?? ""
  return firstSegment.startsWith(".")
}

export function isCodexHomePath(target: string, homeDir: string): boolean {
  const normalizedTarget = target.replace(/\\/g, "/")
  const normalizedHome = homeDir.replace(/\\/g, "/").replace(/\/$/, "")
  const codexRoot = `${normalizedHome}/.codex`
  return normalizedTarget === codexRoot || normalizedTarget.startsWith(`${codexRoot}/`)
}
