/**
 * Action plan generation for git workflow.
 *
 * Builds commit, pull, and push steps based on collaboration mode,
 * branch state, and policy requirements.
 */

import { getCollaborationModePolicy } from "../../src/collaboration-policy.ts"
import type { CollaborationMode } from "../../src/settings.ts"
import { isDefaultBranch, skillExists } from "../../src/utils/hook-utils.ts"
import type { ActionPlanItem } from "./types.ts"

/**
 * Check if collaboration mode allows direct push to main/master.
 */
function allowsDirectMainCollaborationWorkflow(mode: CollaborationMode): boolean {
  return mode === "solo" || mode === "auto"
}

/**
 * Build push sub-steps for a given collaboration policy.
 */
function remotePushSubSteps(
  policy: Awaited<ReturnType<typeof getCollaborationModePolicy>>,
  branch: string,
  onDefaultBranch: boolean,
  trunkMode: boolean,
  defaultBranch: string
): ActionPlanItem[] {
  const steps: ActionPlanItem[] = [`git push origin ${branch}`]
  if (!trunkMode && !onDefaultBranch && policy.requirePullRequest) {
    steps.push(`Open or update a PR: gh pr create --base ${defaultBranch} (if no PR exists)`)
  }
  if (!trunkMode && !onDefaultBranch && policy.requirePeerReview) {
    steps.push("Request a peer review before merging")
  }
  return steps
}

/**
 * Build push sub-steps based on collaboration mode and policy.
 */
function pushSubStepsForPolicy(
  policy: Awaited<ReturnType<typeof getCollaborationModePolicy>>,
  branch: string,
  collabMode: CollaborationMode,
  trunkMode: boolean,
  defaultBranch: string
): ActionPlanItem[] {
  const onDefault = isDefaultBranch(branch, defaultBranch)

  if (trunkMode && onDefault) {
    return [`git push origin ${branch}`]
  }

  if (allowsDirectMainCollaborationWorkflow(collabMode)) {
    return remotePushSubSteps(policy, branch, onDefault, trunkMode, defaultBranch)
  }

  // On default branch when direct push is not permitted
  if (policy.requireFeatureBranch && onDefault && !trunkMode) {
    const steps: ActionPlanItem[] = [
      "Direct push to the default branch is not permitted — create a feature branch",
      `git checkout -b <type>/<slug>`,
      `git push origin <feature-branch>`,
    ]
    if (policy.requirePullRequest) {
      steps.push(`Open a PR: gh pr create --base ${defaultBranch}`)
    }
    if (policy.requirePeerReview) {
      steps.push("Request a peer review before merging")
    }
    return steps
  }

  return remotePushSubSteps(policy, branch, onDefault, trunkMode, defaultBranch)
}

/**
 * Build commit action plan step.
 */
function buildCommitSteps(): [string, ActionPlanItem[]] {
  const subSteps: ActionPlanItem[] = []
  if (skillExists("commit")) {
    subSteps.push("/commit — Stage and commit with Conventional Commits")
  }
  subSteps.push(
    "git add .",
    'git commit -m "<type>(<scope>): <summary>"',
    "Types: feat, fix, refactor, docs, style, test, chore. Keep summary under 50 characters."
  )
  return ["Commit your changes:", subSteps]
}

/**
 * Build pull action plan step.
 */
function buildPullSteps(): [string, ActionPlanItem[]] {
  const subSteps: ActionPlanItem[] = []
  if (skillExists("resolve-conflicts")) {
    subSteps.push("/resolve-conflicts — Use if conflicts arise during rebase")
  }
  subSteps.push("git pull --rebase --autostash")
  return ["Pull and rebase:", subSteps]
}

interface PushStepParams {
  branch: string
  upstream: string
  ahead: number
  collabMode: CollaborationMode
  trunkMode: boolean
  defaultBranch: string
}

/**
 * Build push action plan step.
 */
function buildPushSteps(p: PushStepParams): [string, ActionPlanItem[]] {
  const { branch, upstream, ahead, collabMode, trunkMode, defaultBranch } = p
  const policy = getCollaborationModePolicy(collabMode)
  const onDefault = isDefaultBranch(branch, defaultBranch)
  const mainBlocked =
    !trunkMode &&
    policy.requireFeatureBranch &&
    onDefault &&
    !allowsDirectMainCollaborationWorkflow(collabMode)

  const pushHeader = mainBlocked
    ? `Move commits off '${branch}' to a feature branch:`
    : ahead > 0
      ? `Push ${ahead} commit(s) to '${upstream}':`
      : `Push your committed changes to '${upstream}':`
  const subSteps: ActionPlanItem[] = []
  if (skillExists("push")) {
    subSteps.push("/push — Push to remote with collaboration guard")
  }
  subSteps.push(...pushSubStepsForPolicy(policy, branch, collabMode, trunkMode, defaultBranch))
  return [pushHeader, subSteps]
}

/**
 * Build complete git workflow action plan based on git state.
 */
export function buildGitWorkflowSections(opts: {
  summary: string
  hasUncommitted: boolean
  hasRemote: boolean
  behind: number
  ahead: number
  branch: string
  upstream: string
  collabMode: CollaborationMode
  trunkMode: boolean
  defaultBranch: string
}): ActionPlanItem[] {
  const {
    summary: _,
    hasUncommitted,
    hasRemote,
    behind,
    ahead,
    branch,
    upstream,
    collabMode,
    trunkMode,
    defaultBranch,
  } = opts

  const steps: ActionPlanItem[] = []

  if (hasUncommitted) {
    const [header, subSteps] = buildCommitSteps()
    steps.push(header, ...subSteps)
  }
  if (behind > 0) {
    const [header, subSteps] = buildPullSteps()
    steps.push(header, ...subSteps)
  }
  if (ahead > 0 || (hasUncommitted && hasRemote)) {
    const [header, subSteps] = buildPushSteps({
      branch,
      upstream,
      ahead,
      collabMode,
      trunkMode,
      defaultBranch,
    })
    steps.push(header, ...subSteps)
  }

  return steps
}
