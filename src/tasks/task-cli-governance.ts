/**
 * Task-file CLI governance — two-layer enforcement pattern
 *
 * This module provides the path/command predicates consumed by
 * `hooks/pretooluse-task-governance.ts` to block direct access to the
 * task-file store at `~/.claude/tasks/<session_id>/`.
 *
 * ## Layer 1 — Edit/Write guard (`isBlockedTaskFilePath`)
 * Called from `isBlockedTaskFilesEdit()` in the governance hook. Fires when the
 * agent attempts an Edit or Write whose `file_path` resolves inside the tasks
 * directory. Denial message: `SWIZ_TASKS_FILES_DENY_MESSAGE`.
 *
 * ## Layer 2 — Shell command guard (`isBlockedSwizTaskFilesCommand`)
 * Called for every Bash `command` string. Fires when the command references a
 * task-file path in any shell form (cat, jq, redirections, pipelines, subshells,
 * command chains). Same denial message as layer 1.
 *
 * ## Adding a new task-block rule
 * 1. Extend `normalizeTaskFileText` if a new input encoding is possible (e.g.
 *    percent-encoding, URL-form paths).
 * 2. Add a test fixture in `task-cli-governance.test.ts` demonstrating the new
 *    shape before changing production code.
 * 3. Keep both layers in sync — a rule that only covers the shell path but not
 *    the file-path check (or vice versa) creates a bypass.
 *
 * ## Allowed vs denied examples
 * | Input | Result |
 * |-------|--------|
 * | `"cat ~/.claude/tasks/1.json"` | blocked (shell layer) |
 * | `"~/.claude/tasks/1.json"` (file_path) | blocked (path layer) |
 * | `"swiz tasks adopt"` | allowed (only `adopt` is whitelisted) |
 * | `"~/.claude/settings.json"` | allowed (not inside tasks dir) |
 */
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
