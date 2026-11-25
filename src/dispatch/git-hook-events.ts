/**
 * Events fired by git hooks (through lefthook), never by an agent.
 *
 * An agent reads the JSON a dispatch prints, so a block reaches it as `decision: "block"`. Git
 * reads nothing but the exit status of its hook, so for these events a block has to become a
 * non-zero exit or the commit or push goes ahead regardless.
 */
export const GIT_HOOK_EVENTS: ReadonlySet<string> = new Set(["preCommit", "commitMsg", "prePush"])

/** The reason a git-hook dispatch must fail, or null when the git operation may proceed. */
export function gitHookBlockReason(canonicalEvent: string, response: unknown): string | null {
  if (!GIT_HOOK_EVENTS.has(canonicalEvent)) return null
  if (response === null || typeof response !== "object") return null
  const { decision, reason } = response as { decision?: unknown; reason?: unknown }
  if (decision !== "block") return null
  const stated = typeof reason === "string" ? reason.trim() : ""
  return stated || "blocked without a stated reason"
}
