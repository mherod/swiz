#!/usr/bin/env bun

// Stop hook: Block stop if current branch is not the default branch.
// Runs late in the manifest so higher-priority blockers (secrets, git state, CI) win first.
//
// A feature branch normally must be integrated or left from the default branch.
// A conflicting linked worktree is the preservation exception: once its work is
// pushed to an open PR, forcing checkout or integration could make recovery harder.
//
// Dual-mode: SwizStopHook for inline dispatch + subprocess via runSwizHookAsMain.

import type { SwizHookOutput, SwizStopHook } from "../src/SwizHook.ts"
import { runSwizHookAsMain } from "../src/SwizHook.ts"
import { type StopHookInput, stopHookInputSchema } from "../src/schemas.ts"
import { readProjectSettings } from "../src/settings.ts"
import {
  blockStopObj,
  detectForkTopology,
  forkPrCreateCmd,
  forkPushCmd,
  getDefaultBranch,
  getOpenPrForBranch,
  git,
  hasGhCli,
  isDefaultBranch,
  isGitRepo,
  skillAdvice,
} from "../src/utils/hook-utils.ts"
import type { WorktreePreservationDecision } from "../src/worktree-preservation.ts"
import { evaluateWorktreePreservation } from "../src/worktree-preservation.ts"

interface OpenBranchPr {
  mergeable: string
  number: number
}

type ForkTopology = Awaited<ReturnType<typeof detectForkTopology>>

async function getOpenBranchPr(branch: string, cwd: string): Promise<OpenBranchPr | null> {
  if (!hasGhCli()) return null
  return await getOpenPrForBranch<OpenBranchPr>(branch, cwd, "mergeable,number")
}

function buildTrunkModeOutput(
  branch: string,
  defaultBranch: string
): ReturnType<typeof blockStopObj> {
  return blockStopObj(
    `Stopping on branch '${branch}' — trunk mode requires the default branch ('${defaultBranch}') before the session ends.\n\n` +
      `Switch back: \`git checkout ${defaultBranch}\`\n\n` +
      `Do not open a pull request for trunk-mode work; integrate on '${defaultBranch}'.`
  )
}

function buildPreservationOutput(
  branch: string,
  defaultBranch: string,
  defaultRef: string,
  fork: ForkTopology
): ReturnType<typeof blockStopObj> {
  const prCreateCmd = forkPrCreateCmd(defaultBranch, fork)
  const prOpenFallback = [
    `run: ${prCreateCmd} --fill`,
    `  # --fill uses branch name + commits to populate title/body automatically`,
  ].join("\n")
  return blockStopObj(
    `Preserve linked worktree branch '${branch}' before ending this session. It conflicts with '${defaultRef}', so forcing integration or switching away could strand recoverable work.\n\n` +
      `1. Commit every intended change in this worktree.\n` +
      `2. Push '${branch}' to its remote.\n` +
      `3. Open a PR: ${skillAdvice("pr-open", "use the /pr-open skill to create a pull request.", prOpenFallback)}\n\n` +
      `Once the pushed PR exists, the branch may remain checked out for recovery and review.`
  )
}

function buildStandardFeatureBranchReason(
  branch: string,
  defaultBranch: string,
  pr: OpenBranchPr | null,
  fork: ForkTopology
): string {
  let reason = `Stopping on feature branch '${branch}' — the repository must be on '${defaultBranch}' before the session ends.\n\n`

  if (pr) {
    reason += `PR #${pr.number} is open for this branch. Complete the full PR workflow:\n\n`
    reason += `1. Address any review feedback: \`gh pr view ${pr.number} --comments\`\n`
    reason += `2. Fix all lint and typecheck errors on this branch (including pre-existing ones from ${defaultBranch})\n`
    reason += `3. Push fixes: \`${forkPushCmd(branch, fork)}\`\n`
    reason += `4. Merge the PR: \`gh pr merge ${pr.number} --squash\`\n`
    reason += `   If merge requires external review: \`gh pr edit ${pr.number} --add-reviewer <handle>\`\n`
    reason += `   If branch protection blocks merge: request review, then switch back to '${defaultBranch}'\n`
    reason += `5. After merge, switch to default branch: \`git checkout ${defaultBranch} && git pull\`\n\n`
    reason += `If you cannot merge (waiting on reviewer), switch back to '${defaultBranch}' anyway:\n`
    reason += `  \`git checkout ${defaultBranch}\`\n`
    reason += `The PR remains open for the reviewer. The session must end on '${defaultBranch}'.\n`
    return reason
  }

  reason += `The branch itself signals in-progress work. Possible next steps:\n\n`
  reason += `1. Continue work: stay on '${branch}' and complete the task before stopping.\n`
  const prCreateCmd = forkPrCreateCmd(defaultBranch, fork)
  const prOpenFallback = [
    `run: ${prCreateCmd} --fill`,
    `  # --fill uses branch name + commits to populate title/body automatically`,
  ].join("\n")
  reason += `2. Open a PR: ${skillAdvice("pr-open", "use the /pr-open skill to create a pull request.", prOpenFallback)}\n`
  const switchTasksFallback = [
    `run: git checkout ${defaultBranch} && gh issue list --search "is:open label:ready"`,
    `  # switch to default branch and pick up the next ready issue`,
  ].join("\n")
  reason += `3. Switch tasks: ${skillAdvice("work-on-issue", "use the /work-on-issue skill to pick up another issue.", switchTasksFallback)}\n`
  reason += `4. Return to default: run \`git checkout ${defaultBranch}\` if the branch work is intentionally deferred.\n`
  return reason
}

async function resolveWorktreePreservation(
  cwd: string,
  branch: string,
  defaultBranch: string,
  pr: OpenBranchPr | null
): Promise<WorktreePreservationDecision> {
  const input = { cwd, branch, defaultBranch, trunkMode: false }
  if (pr?.mergeable === "CONFLICTING") {
    return await evaluateWorktreePreservation({ ...input, conflictsWithDefault: true })
  }
  return await evaluateWorktreePreservation(input)
}

async function handlePreservedWorktree(
  branch: string,
  defaultBranch: string,
  defaultRef: string,
  pr: OpenBranchPr | null,
  cwd: string
): Promise<SwizHookOutput> {
  if (pr) return {}
  const fork = await detectForkTopology(cwd)
  return buildPreservationOutput(branch, defaultBranch, defaultRef, fork)
}

export async function evaluateStopNonDefaultBranch(input: StopHookInput): Promise<SwizHookOutput> {
  const parsed = stopHookInputSchema.parse(input)
  const cwd = parsed.cwd ?? process.cwd()

  if (!(await isGitRepo(cwd))) return {}

  const branch = await git(["branch", "--show-current"], cwd)
  if (!branch) return {}

  const defaultBranch = await getDefaultBranch(cwd)
  if (isDefaultBranch(branch, defaultBranch)) return {}

  const trunkMode = (await readProjectSettings(cwd))?.trunkMode === true
  if (trunkMode) return buildTrunkModeOutput(branch, defaultBranch)

  const pr = await getOpenBranchPr(branch, cwd)

  const preservation = await resolveWorktreePreservation(cwd, branch, defaultBranch, pr)

  if (preservation.preserveViaPr) {
    return await handlePreservedWorktree(branch, defaultBranch, preservation.defaultRef, pr, cwd)
  }

  const fork = await detectForkTopology(cwd)
  return blockStopObj(buildStandardFeatureBranchReason(branch, defaultBranch, pr, fork))
}

const stopNonDefaultBranch: SwizStopHook = {
  name: "stop-non-default-branch",
  event: "stop",
  timeout: 10,
  requiredSettings: ["nonDefaultBranchGate"],

  run(input) {
    return evaluateStopNonDefaultBranch(input)
  },
}

export default stopNonDefaultBranch

if (import.meta.main) {
  await runSwizHookAsMain(stopNonDefaultBranch)
}
