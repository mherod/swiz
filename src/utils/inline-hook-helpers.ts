/**
 * Safe helper functions for inline SwizHook implementations.
 *
 * This module must NOT import from hook-utils.ts, skill-utils.ts, agents.ts,
 * or any module that creates a circular dependency through manifest.ts.
 *
 * Safe to import from manifest.ts via inline hooks.
 */

import type { ToolHookInput } from "../../hooks/schemas.ts"
import { shellTokenCommandRe } from "./shell-patterns.ts"

// ─── Issue guidance ──────────────────────────────────────────────────────────

export function buildIssueGuidance(
  repo: string | null,
  options?: { crossRepo?: boolean; hostname?: string }
): string {
  const isCrossRepo = options?.crossRepo ?? false
  const hostname = options?.hostname ?? "github.com"
  const hostnameFlag = hostname !== "github.com" ? ` --hostname ${hostname}` : ""
  const repoSlug = repo ?? "<owner>/<repo>"

  const prefix = isCrossRepo
    ? "If this change is needed, consider filing an issue there so the repo can triage it:"
    : "If you need to edit a file outside the project, file an issue on the target repo instead:"

  return `${prefix}\n  gh issue create --repo ${repoSlug}${hostnameFlag} --title "..." --body "..."`
}

// ─── Settings command detection ───────────────────────────────────────────────

export function isSettingDisableCommand(command: string, aliases: string[]): boolean {
  for (const alias of aliases) {
    if (new RegExp(`swiz\\s+settings\\s+disable\\s+${alias}(?:\\s|$)`).test(command)) return true
    if (new RegExp(`swiz\\s+settings\\s+set\\s+${alias}\\s+false(?:\\s|$)`).test(command))
      return true
  }
  return false
}

// ─── Swiz command detection ──────────────────────────────────────────────────

export const SWIZ_CMD_RE = shellTokenCommandRe("swiz(?:\\s|$)")

/**
 * Returns true if the Bash command is a `swiz` CLI invocation.
 * Swiz commands are globally exempt from PreToolUse blocking because the CLI
 * performs its own validation — blocking the project's own entry point creates
 * unrecoverable deadlocks (e.g. can't run `swiz state set` to escape a state
 * that blocks Bash).
 */
export function isSwizCommand(input: ToolHookInput): boolean {
  const cmd = String(input.tool_input?.command ?? "")
  return SWIZ_CMD_RE.test(cmd)
}

// ─── Placeholder subject detection ──────────────────────────────────────────

/**
 * Matches all auto-generated placeholder task subjects:
 *   - "Recovered task #N (lost during compaction)" — pretooluse-task-recovery / posttooluse-task-recovery
 *   - "Session bootstrap — describe current work"  — legacy pretooluse-require-tasks placeholder
 */
export const PLACEHOLDER_SUBJECT_RE = /^(?:recovered task|session bootstrap)\b/i

/** Returns true if the subject is an auto-generated placeholder (not real agent work). */
export function isPlaceholderSubject(subject: string): boolean {
  return PLACEHOLDER_SUBJECT_RE.test(subject.trim())
}
