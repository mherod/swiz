/**
 * Safe helper functions for inline SwizHook implementations.
 *
 * This module must NOT import from hook-utils.ts, skill-utils.ts, agents.ts,
 * or any module that creates a circular dependency through manifest.ts.
 *
 * Safe to import from manifest.ts via inline hooks.
 */

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
