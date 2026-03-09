#!/usr/bin/env bun

// PostToolUse hook: Auto-transition project state based on PR lifecycle events.
//
// Transitions (synchronous — command-pattern only):
//   gh pr create           : developing → reviewing
//   gh pr merge            : reviewing  → developing
//   gh pr review --dismiss : reviewing  → addressing-feedback
//
// Transitions (async — require runtime checks):
//   git commit + branch has CHANGES_REQUESTED PR reviews : reviewing → addressing-feedback
//   git commit + branch has no upstream tracking         : planning|reviewing|addressing-feedback → developing
//   git commit + on default branch (solo repo)           : reviewing|addressing-feedback → developing
//   git checkout <default-branch>                        : reviewing | addressing-feedback → developing
//   git checkout -b <new-branch> (from default branch)  : any → developing
//   git checkout <branch> (HEAD authored by other user)  : any → reviewing
//   gh pr checkout <number> (HEAD authored by other user): any → reviewing
//
// Only transitions if current state matches the expected source state(s),
// so this is safe to run regardless of workflow or whether PRs are used.

import { detectProjectCollaborationPolicy } from "../src/collaboration-policy.ts"
import { readProjectState, writeProjectState } from "../src/settings.ts"
import { getOpenPrForBranch, git, hasGhCli, isGitHubRemote, isGitRepo } from "./hook-utils.ts"
import { toolHookInputSchema } from "./schemas.ts"
import {
  GH_PR_CHECKOUT_RE,
  GH_PR_CREATE_RE,
  GH_PR_MERGE_RE,
  GH_PR_REVIEW_DISMISS_RE,
  GIT_CHECKOUT_NEW_BRANCH_RE,
  GIT_CHECKOUT_RE,
  GIT_COMMIT_RE,
  getDefaultBranch,
  getGitStatusV2,
  isDefaultBranch,
} from "./utils/git-utils.ts"

type ProjectState = "developing" | "reviewing" | "addressing-feedback" | "planning"

type SyncTransitionRule = {
  when: RegExp
  from: ProjectState | ProjectState[]
  to: ProjectState
}

type UpstreamTransitionStatus = "transitioned" | "no-transition" | "abort"

const SYNC_RULES: readonly SyncTransitionRule[] = [
  { when: GH_PR_CREATE_RE, from: "developing", to: "reviewing" },
  { when: GH_PR_MERGE_RE, from: ["reviewing", "addressing-feedback"], to: "developing" },
  { when: GH_PR_REVIEW_DISMISS_RE, from: "reviewing", to: "addressing-feedback" },
]

function matchesSyncRule(command: string, state: ProjectState): SyncTransitionRule | null {
  for (const rule of SYNC_RULES) {
    if (!rule.when.test(command)) continue
    const fromStates = Array.isArray(rule.from) ? rule.from : [rule.from]
    if (fromStates.includes(state)) return rule
  }
  return null
}

function isReviewingLikeState(state: ProjectState): boolean {
  return state === "reviewing" || state === "addressing-feedback"
}

/** Extract the target branch from `git checkout <branch>` (non -b form). */
function extractCheckoutBranch(command: string): string | null {
  // Match: git checkout <branch> — not a flag, not -b/-B/-c/-C
  const match = command.match(/\bgit\s+checkout\s+(?!-[bcBC](?:\s|$))([^\s;|&-][^\s;|&]*)/)
  return match?.[1] ?? null
}

function extractCheckoutStartPoint(command: string): string | null {
  const checkoutMatch = command.match(
    /\bgit\s+checkout\s+-[bB]\s+[^\s;|&]+(?:\s+([^\s;|&-][^\s;|&]*))?/
  )
  if (checkoutMatch?.[1]) return checkoutMatch[1]

  const switchMatch = command.match(
    /\bgit\s+switch\s+-[cC]\s+[^\s;|&]+(?:\s+([^\s;|&-][^\s;|&]*))?/
  )
  if (switchMatch?.[1]) return switchMatch[1]

  return null
}

async function resolveCheckoutSourceBranch(command: string, cwd: string): Promise<string | null> {
  const explicitStartPoint = extractCheckoutStartPoint(command)
  if (explicitStartPoint) return explicitStartPoint

  try {
    const previousBranch = (await git(["rev-parse", "--abbrev-ref", "@{-1}"], cwd)).trim()
    if (previousBranch && previousBranch !== "@{-1}") return previousBranch
  } catch {
    // ignore and fall through
  }

  return null
}

/**
 * Return true if the HEAD commit of the current branch was authored by someone
 * other than the configured git user. Compares `git log -1 --format=%ae HEAD`
 * against `git config user.email`, case-insensitively. Returns false on any
 * error (missing git config, empty output, etc.) so the caller can skip silently.
 */
async function isHeadAuthoredByOther(cwd: string): Promise<boolean> {
  try {
    const headEmail = (await git(["log", "-1", "--format=%ae", "HEAD"], cwd)).trim().toLowerCase()
    if (!headEmail) return false
    const userEmail = (await git(["config", "user.email"], cwd)).trim().toLowerCase()
    if (!userEmail) return false
    return headEmail !== userEmail
  } catch {
    return false
  }
}

async function transitionToAddressingFeedbackOnChangesRequested(cwd: string): Promise<boolean> {
  if (!hasGhCli() || !(await isGitHubRemote(cwd))) return false

  try {
    const branch = (await git(["branch", "--show-current"], cwd)).trim()
    if (!branch) return false

    const pr = await getOpenPrForBranch<{ reviews: Array<{ state: string }> }>(
      branch,
      cwd,
      "reviews"
    )
    if (!pr?.reviews?.some((r) => r.state === "CHANGES_REQUESTED")) return false

    await writeProjectState(cwd, "addressing-feedback")
    return true
  } catch {
    // gh unavailable or API error — skip
    return false
  }
}

async function transitionToDevelopingOnMissingUpstream(
  cwd: string
): Promise<UpstreamTransitionStatus> {
  try {
    const status = await getGitStatusV2(cwd)
    // Preserve existing behavior: if status cannot be determined, abort async
    // transition handling for this command.
    if (!status) return "abort"

    // "no valid upstream" covers both:
    // 1) no upstream configured (status.upstream === null)
    // 2) upstream configured but gone on remote (status.upstreamGone === true)
    if (status.upstream === null || status.upstreamGone) {
      await writeProjectState(cwd, "developing")
      return "transitioned"
    }
    return "no-transition"
  } catch {
    // skip
    return "no-transition"
  }
}

async function transitionToDevelopingOnSoloDefaultBranchCommit(cwd: string): Promise<boolean> {
  try {
    const branch = (await git(["branch", "--show-current"], cwd)).trim()
    if (!branch) return false

    const defaultBranch = await getDefaultBranch(cwd)
    if (!isDefaultBranch(branch, defaultBranch)) return false

    const collaboration = await detectProjectCollaborationPolicy(cwd)
    if (collaboration.isCollaborative) return false

    await writeProjectState(cwd, "developing")
    return true
  } catch {
    // skip
    return false
  }
}

async function handleAsyncTransitions(
  command: string,
  cwd: string,
  state: ProjectState
): Promise<boolean> {
  const isCommit = GIT_COMMIT_RE.test(command)
  const isReviewingLike = isReviewingLikeState(state)
  const isNoUpstreamTransitionState = state === "planning" || isReviewingLike

  // ── git commit: reviewing → addressing-feedback if PR has CHANGES_REQUESTED ──
  if (isCommit && state === "reviewing") {
    if (await transitionToAddressingFeedbackOnChangesRequested(cwd)) return true
  }

  // ── git commit + no valid upstream tracking: planning|reviewing|addressing-feedback → developing ──
  if (isCommit && isNoUpstreamTransitionState) {
    const upstreamStatus = await transitionToDevelopingOnMissingUpstream(cwd)
    if (upstreamStatus === "transitioned") return true
    if (upstreamStatus === "abort") return false

    // ── git commit on default branch (solo repo): reviewing|addressing-feedback → developing ──
    if (await transitionToDevelopingOnSoloDefaultBranchCommit(cwd)) return true
  }

  // ── git checkout <default-branch>: reviewing|addressing-feedback → developing ──
  if (GIT_CHECKOUT_RE.test(command) && !GIT_CHECKOUT_NEW_BRANCH_RE.test(command)) {
    if (isReviewingLike) {
      const targetBranch = extractCheckoutBranch(command)
      if (targetBranch) {
        try {
          const defaultBranch = await getDefaultBranch(cwd)
          if (isDefaultBranch(targetBranch, defaultBranch)) {
            await writeProjectState(cwd, "developing")
            return true
          }
        } catch {
          // skip
        }
      }
    }
  }

  // ── git checkout / gh pr checkout: any → reviewing if HEAD authored by other user ──
  // Runs after the default-branch rule above so developing takes priority over reviewing
  // when checking out the default branch.
  const isPlainCheckout = GIT_CHECKOUT_RE.test(command) && !GIT_CHECKOUT_NEW_BRANCH_RE.test(command)
  const isPrCheckout = GH_PR_CHECKOUT_RE.test(command)
  if ((isPlainCheckout || isPrCheckout) && state !== "reviewing") {
    if (await isHeadAuthoredByOther(cwd)) {
      await writeProjectState(cwd, "reviewing")
      return true
    }
  }

  // ── git checkout -b / git switch -c: any → developing (only from default branch) ──
  if (GIT_CHECKOUT_NEW_BRANCH_RE.test(command)) {
    try {
      const sourceBranch = await resolveCheckoutSourceBranch(command, cwd)
      const defaultBranch = await getDefaultBranch(cwd)
      if (sourceBranch && isDefaultBranch(sourceBranch, defaultBranch)) {
        await writeProjectState(cwd, "developing")
        return true
      }
    } catch {
      // skip
    }
  }

  return false
}

async function main(): Promise<void> {
  const input = toolHookInputSchema.parse(await Bun.stdin.json())
  const cwd = input.cwd
  if (!cwd) return

  if (input.tool_name !== "Bash" && input.tool_name !== "mcp__ide__runCommand") return
  if (!(await isGitRepo(cwd))) return

  const command = String(input.tool_input?.command ?? "")
  const state = (await readProjectState(cwd)) as ProjectState | null
  if (!state) return

  // Synchronous rules first (fast, no API calls)
  const syncRule = matchesSyncRule(command, state)
  if (syncRule) {
    await writeProjectState(cwd, syncRule.to)
    return
  }

  // Async rules (may involve gh API or git subprocess)
  await handleAsyncTransitions(command, cwd, state)
}

main()
