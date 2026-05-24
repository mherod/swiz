import { realpath } from "node:fs/promises"
import { basename, dirname, join as joinPath, resolve } from "node:path"
import { normalizeCommand, stripHeredocs } from "../src/command-utils.ts"
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
