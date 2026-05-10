import { expandHomeVars, getHomeDirOrNull } from "../home.ts"
import { shellTokenCommandRe, stripQuotedShellStrings } from "../utils/shell-patterns.ts"
import { SWIZ_TASKS_CLI_DENY_MESSAGE } from "./task-governance-messages.ts"

const SWIZ_TASKS_CLI_RE = shellTokenCommandRe(String.raw`swiz\s+tasks(?:\s|$)`)
const SWIZ_TASKS_CLI_SUBCOMMAND_RE = shellTokenCommandRe(
  String.raw`swiz\s+tasks\s+([^\s;|&]+)(?:\s|$)`
)

const SWIZ_TASKS_ALLOWED_SUBCOMMANDS = new Set(["adopt"])
const TASK_FILES_DIR_MARKER_RE = /(?:^|[\s"'`;|&()/\\])\.claude\/tasks(?:\/|$)/i

function normalizeTaskFileText(value: string): string {
  const homeDir = getHomeDirOrNull() ?? "~"
  const normalized = expandHomeVars(value, homeDir).replace(/["'`]/g, "")
  return normalized.replace(/\\/g, "/").toLowerCase()
}

function containsTaskFilesDirectory(value: string): boolean {
  return TASK_FILES_DIR_MARKER_RE.test(normalizeTaskFileText(value))
}

export function isBlockedTaskFilePath(filePath: string): boolean {
  return containsTaskFilesDirectory(filePath)
}

export function isBlockedSwizTaskFilesCommand(command: string): boolean {
  return containsTaskFilesDirectory(command)
}

export function isSwizTasksCommand(command: string): boolean {
  return SWIZ_TASKS_CLI_RE.test(stripQuotedShellStrings(command))
}

export function extractSwizTasksSubcommand(command: string): string | undefined {
  const stripped = stripQuotedShellStrings(command)
  if (!SWIZ_TASKS_CLI_RE.test(stripped)) return undefined

  const match = stripped.match(SWIZ_TASKS_CLI_SUBCOMMAND_RE)
  if (!match?.[1]) return undefined

  const subcommand = match[1]!.trim()
  if (subcommand.startsWith("-")) return undefined
  return subcommand
}

export function isAllowedSwizTasksSubcommand(subcommand: string | undefined): boolean {
  if (!subcommand) return false
  return SWIZ_TASKS_ALLOWED_SUBCOMMANDS.has(subcommand)
}

export function isBlockedSwizTasksSubcommand(subcommand: string | undefined): boolean {
  return !isAllowedSwizTasksSubcommand(subcommand)
}

export function isBlockedSwizTasksCliCommand(command: string): boolean {
  if (!isSwizTasksCommand(command)) return false
  return isBlockedSwizTasksSubcommand(extractSwizTasksSubcommand(command))
}

export { SWIZ_TASKS_CLI_DENY_MESSAGE }
