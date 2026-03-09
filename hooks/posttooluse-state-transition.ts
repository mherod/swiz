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
//   git commit + branch has no upstream tracking         : any → developing
//   git commit + on default branch (solo repo)           : reviewing|addressing-feedback → developing
//   git checkout <default-branch>                        : reviewing | addressing-feedback → developing
//   git checkout -b <new-branch> (from default branch)  : any → developing
//
// Only transitions if current state matches the expected source state(s),
// so this is safe to run regardless of workflow or whether PRs are used.

import { detectProjectCollaborationPolicy } from "../src/collaboration-policy.ts"
import { readProjectState, writeProjectState } from "../src/settings.ts"
import { getOpenPrForBranch, git, hasGhCli, isGitHubRemote, isGitRepo } from "./hook-utils.ts"
import { toolHookInputSchema } from "./schemas.ts"
import {
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

/** Extract the target branch from `git checkout <branch>` (non -b form). */
function extractCheckoutBranch(command: string): string | null {
  // Match: git checkout <branch> — not a flag, not -b/-B/-c/-C
  const match = command.match(/\bgit\s+checkout\s+(?!-[bcBC](?:\s|$))([^\s;|&-][^\s;|&]*)/)
  return match?.[1] ?? null
}

async function handleAsyncTransitions(
  command: string,
  cwd: string,
  state: ProjectState
): Promise<boolean> {
  // ── git commit: reviewing → addressing-feedback if PR has CHANGES_REQUESTED ──
  if (GIT_COMMIT_RE.test(command) && state === "reviewing") {
    if (hasGhCli() && (await isGitHubRemote(cwd))) {
      try {
        const branch = (await git(["branch", "--show-current"], cwd)).trim()
        if (branch) {
          const pr = await getOpenPrForBranch<{ reviews: Array<{ state: string }> }>(
            branch,
            cwd,
            "reviews"
          )
          if (pr?.reviews?.some((r) => r.state === "CHANGES_REQUESTED")) {
            await writeProjectState(cwd, "addressing-feedback")
            return true
          }
        }
      } catch {
        // gh unavailable or API error — skip
      }
    }
  }

  // ── git commit + no valid upstream tracking: reviewing|addressing-feedback → developing ──
  if (GIT_COMMIT_RE.test(command) && (state === "reviewing" || state === "addressing-feedback")) {
    try {
      const status = await getGitStatusV2(cwd)
      if (!status) return false

      // "no valid upstream" covers both:
      // 1) no upstream configured (status.upstream === null)
      // 2) upstream configured but gone on remote (status.upstreamGone === true)
      if (status.upstream === null || status.upstreamGone) {
        await writeProjectState(cwd, "developing")
        return true
      }
    } catch {
      // skip
    }
  }

  // ── git commit on default branch (solo repo): reviewing|addressing-feedback → developing ──
  if (GIT_COMMIT_RE.test(command) && (state === "reviewing" || state === "addressing-feedback")) {
    try {
      const branch = (await git(["branch", "--show-current"], cwd)).trim()
      if (branch) {
        const defaultBranch = await getDefaultBranch(cwd)
        if (isDefaultBranch(branch, defaultBranch)) {
          const collaboration = await detectProjectCollaborationPolicy(cwd)
          if (!collaboration.isCollaborative) {
            await writeProjectState(cwd, "developing")
            return true
          }
        }
      }
    } catch {
      // skip
    }
  }

  // ── git checkout <default-branch>: reviewing|addressing-feedback → developing ──
  if (GIT_CHECKOUT_RE.test(command) && !GIT_CHECKOUT_NEW_BRANCH_RE.test(command)) {
    if (state === "reviewing" || state === "addressing-feedback") {
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

  // ── git checkout -b / git switch -c: any → developing (only from default branch) ──
  if (GIT_CHECKOUT_NEW_BRANCH_RE.test(command)) {
    try {
      const currentBranch = (await git(["branch", "--show-current"], cwd)).trim()
      const defaultBranch = await getDefaultBranch(cwd)
      if (currentBranch && isDefaultBranch(currentBranch, defaultBranch)) {
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
