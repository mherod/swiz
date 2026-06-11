import { realpath } from "node:fs/promises"
import { basename, dirname, join as joinPath, resolve } from "node:path"
import { normalizeCommand, stripHeredocs } from "../src/command-utils.ts"
import { expandHomeVars, getHomeDirOrNull } from "../src/home.ts"
import { stripQuotedShellStrings } from "../src/utils/shell-patterns.ts"

const SAFE_READ_ONLY_COMMANDS = new Set([
  "cat",
  "head",
  "tail",
  "grep",
  "rg",
  "sed",
  "ls",
  "stat",
  "wc",
  "cut",
  "sort",
  "uniq",
  "tr",
])

export const SAFE_READ_ONLY_INSPECTION_HINT = [
  "If you only need to inspect the file, use Read or a read-only shell command (cat, head, tail, grep, rg, sed -n).",
  "Skill files under configured skill roots (e.g., ~/.claude/skills/, ~/.cursor/skills/) are readable with those commands.",
  "Use the local .skills/ copy when the global path is not accessible.",
  "Do not chain writes, tees, redirects, or command substitution when you only need a read.",
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

/**
 * Returns true when a shell command is a simple read-only inspection command.
 *
 * The validator is intentionally strict: it only permits direct read commands
 * and pipelines of read commands, and it rejects shell chaining, redirects,
 * and command substitution.
 */
export function isSafeReadOnlyShellCommand(command: string): boolean {
  if (!command.trim()) return false
  const normalized = command.normalize("NFKC")
  if (normalized.includes("`") || normalized.includes("$(")) return false

  const sanitized = stripBenignRedirects(sanitizeShellCommand(normalized))
  if (!sanitized) return false
  if (
    sanitized.includes("&&") ||
    sanitized.includes("||") ||
    sanitized.includes(";") ||
    sanitized.includes("&") ||
    sanitized.includes(">") ||
    sanitized.includes("<")
  ) {
    return false
  }

  const stages = sanitized
    .split("|")
    .map((stage) => stage.trim())
    .filter(Boolean)
  if (stages.length === 0) return false

  for (const stage of stages) {
    const commandName = stage.match(/^[^\s]+/)?.[0] ?? ""
    if (!SAFE_READ_ONLY_COMMANDS.has(commandName)) return false
    if (commandName === "sed" && !isSafeSedCommand(stage)) return false
  }

  return true
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
