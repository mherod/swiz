#!/usr/bin/env bun

// Stop hook: Block stop if current branch is not the default branch.
// Runs late in the manifest so higher-priority blockers (secrets, git state, CI) win first.
//
// A feature branch normally must be integrated or left from the default branch.
// A branch with no open PR (or an already-merged one) always blocks, regardless of
// nonDefaultBranchGate or the stop continuation mode: open a PR, or switch back.
// A conflicting linked worktree is the preservation exception: once its work is
// pushed to an open PR, forcing checkout or integration could make recovery harder.
//
// Dual-mode: SwizStopHook for inline dispatch + subprocess via runSwizHookAsMain.

import {
  detectForkTopology,
  forkPrCreateCmd,
  forkPushCmd,
  ghJson,
  git,
  hasGhCli,
} from "../src/git-helpers.ts"
import { isGitRepoForHookPayload } from "../src/repository-capability.ts"
import type { SwizHookOutput, SwizStopHook } from "../src/SwizHook.ts"
import { runSwizHookAsMain } from "../src/SwizHook.ts"
import { type StopHookInput, stopHookInputSchema } from "../src/schemas.ts"
import { readProjectSettings } from "../src/settings.ts"
import { skillAdvice } from "../src/skill-utils.ts"
import { getDefaultBranch, isDefaultBranch } from "../src/utils/git-utils.ts"
import { blockStopObj } from "../src/utils/hook-response.ts"
import {
  buildOwnershipHoldReason,
  type PeerHeldFilesResult,
  resolvePeerHeldFiles,
} from "../src/utils/session-file-ownership.ts"
import type { WorktreePreservationDecision } from "../src/worktree-preservation.ts"
import { evaluateWorktreePreservation } from "../src/worktree-preservation.ts"

interface OpenBranchPr {
  mergeable: string
  number: number
}

export interface MergedBranchPr {
  number: number
  headRefOid: string
}

type ForkTopology = Awaited<ReturnType<typeof detectForkTopology>>

/** `known: false` when gh is missing or the query failed — absence of a PR is unproven. */
export interface OpenBranchPrState {
  known: boolean
  pr: OpenBranchPr | null
}

async function getOpenBranchPrState(branch: string, cwd: string): Promise<OpenBranchPrState> {
  if (!hasGhCli() || !branch) return { known: false, pr: null }
  const prs = await ghJson<OpenBranchPr[]>(
    ["pr", "list", "--head", branch, "--state", "open", "--json", "mergeable,number"],
    cwd
  )
  if (!Array.isArray(prs)) return { known: false, pr: null }
  return { known: true, pr: prs[0] ?? null }
}

/** Most recent merged PR whose head is this branch, or null when none (or gh unavailable). */
async function getMergedBranchPr(branch: string, cwd: string): Promise<MergedBranchPr | null> {
  if (!hasGhCli() || !branch) return null
  const prs = await ghJson<MergedBranchPr[]>(
    [
      "pr",
      "list",
      "--head",
      branch,
      "--state",
      "merged",
      "--limit",
      "1",
      "--json",
      "number,headRefOid",
    ],
    cwd
  )
  return prs?.[0] ?? null
}

export function buildMergedPrReason(
  branch: string,
  defaultBranch: string,
  pr: MergedBranchPr,
  unmergedCommits: number
): string {
  let reason = `PR #${pr.number} for branch '${branch}' has already been merged upstream — this branch is finished.\n\n`
  reason += `Switch back to '${defaultBranch}' and pull the merged changes:\n`
  reason += `  \`git checkout ${defaultBranch} && git pull\`\n`
  if (unmergedCommits > 0) {
    reason += `\n'${branch}' has ${unmergedCommits} commit(s) made after the merged PR head. Carry them onto '${defaultBranch}' (or a fresh branch) before switching so they are not stranded.\n`
  }
  reason += `\nDo not keep working on a merged PR branch.`
  return reason
}

async function countCommitsAfter(headRefOid: string, cwd: string): Promise<number> {
  const out = await git(["rev-list", "--count", `${headRefOid}..HEAD`], cwd)
  const n = Number(out)
  return Number.isFinite(n) ? n : 0
}

async function resolveMergedPrBlock(
  branch: string,
  defaultBranch: string,
  pr: OpenBranchPr | null,
  cwd: string
): Promise<SwizHookOutput | null> {
  if (pr) return null
  const merged = await getMergedBranchPr(branch, cwd)
  if (!merged) return null
  const extra = await countCommitsAfter(merged.headRefOid, cwd)
  return blockStopObj(buildMergedPrReason(branch, defaultBranch, merged, extra))
}

export function buildTrunkModeOutput(
  branch: string,
  defaultBranch: string,
  ownership: PeerHeldFilesResult
): ReturnType<typeof blockStopObj> {
  const hold = buildOwnershipHoldReason(ownership)
  if (hold) return blockStopObj(hold)
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

export function buildStandardFeatureBranchReason(
  branch: string,
  defaultBranch: string,
  pr: OpenBranchPr | null,
  fork: ForkTopology,
  ownership: PeerHeldFilesResult
): string {
  const hold = buildOwnershipHoldReason(ownership)
  if (hold) return hold
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

  reason += `No pull request is open for '${branch}'. Do one of the following before stopping:\n\n`
  const prCreateCmd = forkPrCreateCmd(defaultBranch, fork)
  const prOpenFallback = [
    `run: ${prCreateCmd} --fill`,
    `  # --fill uses branch name + commits to populate title/body automatically`,
  ].join("\n")
  reason += `1. Open a PR: commit your work, push it (\`${forkPushCmd(branch, fork)}\`), then ${skillAdvice("pr-open", "use the /pr-open skill to create a pull request.", prOpenFallback)}\n`
  reason += `2. If the branch work is already finished (merged or carried onto '${defaultBranch}'), switch back:\n`
  reason += `   \`git checkout ${defaultBranch} && git pull\`\n`
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
  const cwd = parsed.cwd
  if (!cwd?.trim()) {
    return blockStopObj(buildOwnershipHoldReason({ known: false, reason: "missing-cwd" }))
  }

  if (!(await isGitRepoForHookPayload(parsed, cwd))) return {}

  const branch = await git(["branch", "--show-current"], cwd)
  if (!branch) return {}

  const defaultBranch = await getDefaultBranch(cwd)
  if (isDefaultBranch(branch, defaultBranch)) return {}

  const peerHeldFiles = await resolvePeerHeldFiles(cwd, parsed.session_id)
  const hold = buildOwnershipHoldReason(peerHeldFiles)
  if (hold) return blockStopObj(hold)

  const prState = await getOpenBranchPrState(branch, cwd)
  const pr = prState.pr
  // The merged-PR and no-open-PR blocks always run; nonDefaultBranchGate and the
  // continuation mode only relax branches with an open PR (or unknown PR state).
  const mergedBlock = await resolveMergedPrBlock(branch, defaultBranch, pr, cwd)
  if (mergedBlock) return mergedBlock
  if (isBranchGateRelaxed(input, prState)) return {}

  return await evaluateUnmergedFeatureBranch(cwd, branch, defaultBranch, pr, peerHeldFiles)
}

/**
 * True when the gate setting or a restricted continuation mode may skip the block.
 * A branch proven to have no open PR is never relaxed: open one, or switch back.
 */
export function isBranchGateRelaxed(input: StopHookInput, prState: OpenBranchPrState): boolean {
  if (prState.known && !prState.pr) return false
  return !isNonDefaultBranchGateEnabled(input) || isRestrictedStopContinuation(input)
}

/** Commit/delivery stop modes keep this hook only for the merged-PR and no-PR blocks. */
function isRestrictedStopContinuation(input: StopHookInput): boolean {
  const mode = input._stopContinuationMode
  return mode === "commit" || mode === "delivery"
}

/** Payload-supplied gate value; defaults to enabled when dispatch did not inject settings. */
function isNonDefaultBranchGateEnabled(input: StopHookInput): boolean {
  const settings = (input as Record<string, unknown>)._effectiveSettings as
    | { nonDefaultBranchGate?: unknown }
    | undefined
  return settings?.nonDefaultBranchGate !== false
}

async function evaluateUnmergedFeatureBranch(
  cwd: string,
  branch: string,
  defaultBranch: string,
  pr: OpenBranchPr | null,
  peerHeldFiles: PeerHeldFilesResult
): Promise<SwizHookOutput> {
  const trunkMode = (await readProjectSettings(cwd))?.trunkMode === true
  if (trunkMode) return buildTrunkModeOutput(branch, defaultBranch, peerHeldFiles)

  const preservation = await resolveWorktreePreservation(cwd, branch, defaultBranch, pr)

  if (preservation.preserveViaPr) {
    return await handlePreservedWorktree(branch, defaultBranch, preservation.defaultRef, pr, cwd)
  }

  const fork = await detectForkTopology(cwd)
  return blockStopObj(
    buildStandardFeatureBranchReason(branch, defaultBranch, pr, fork, peerHeldFiles)
  )
}

const stopNonDefaultBranch: SwizStopHook = {
  name: "stop-non-default-branch",
  event: "stop",
  timeout: 10,

  run(input) {
    return evaluateStopNonDefaultBranch(input)
  },
}

export default stopNonDefaultBranch

if (import.meta.main) {
  await runSwizHookAsMain(stopNonDefaultBranch)
}
