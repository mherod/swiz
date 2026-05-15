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
  "If you only need to inspect the target, use Read or a read-only shell command instead of Edit/Write.",
  "Safe examples: cat, head, tail, grep, rg, and sed -n.",
  "Do not append writes, tees, redirects, or command chaining when you only need a read.",
].join(" ")

function sanitizeShellCommand(command: string): string {
  return stripQuotedShellStrings(stripHeredocs(normalizeCommand(command).normalize("NFKC")))
    .replace(/\s+/g, " ")
    .trim()
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

  const sanitized = sanitizeShellCommand(normalized)
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
