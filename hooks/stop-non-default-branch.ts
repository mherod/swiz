#!/usr/bin/env bun

// Stop hook: Block stop if current branch is not the default branch.
// Runs late in the manifest so higher-priority blockers (secrets, git state, CI) win first.
//
// The agent must finish on the default branch. Being on a feature branch means
// the repository is in a dirty state — even if a PR exists, the agent should
// complete all review tasks, merge the PR, and switch back to main before stopping.
//
// Dual-mode: SwizStopHook for inline dispatch + subprocess via runSwizHookAsMain.

import type { SwizHookOutput, SwizStopHook } from "../src/SwizHook.ts"
import { runSwizHookAsMain } from "../src/SwizHook.ts"
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
import { type StopHookInput, stopHookInputSchema } from "./schemas.ts"

export async function evaluateStopNonDefaultBranch(input: StopHookInput): Promise<SwizHookOutput> {
  const parsed = stopHookInputSchema.parse(input)
  const cwd = parsed.cwd ?? process.cwd()

  if (!(await isGitRepo(cwd))) return {}

  const branch = await git(["branch", "--show-current"], cwd)
  if (!branch) return {}

  const defaultBranch = await getDefaultBranch(cwd)
  if (isDefaultBranch(branch, defaultBranch)) return {}

  const trunkMode = (await readProjectSettings(cwd))?.trunkMode === true
  if (trunkMode) {
    return blockStopObj(
      `Stopping on branch '${branch}' — trunk mode requires the default branch ('${defaultBranch}') before the session ends.\n\n` +
        `Switch back: \`git checkout ${defaultBranch}\`\n\n` +
        `Do not open a pull request for trunk-mode work; integrate on '${defaultBranch}'.`
    )
  }

  let pr: { number: number } | null = null
  if (hasGhCli()) {
    pr = await getOpenPrForBranch<{ number: number }>(branch, cwd, "number")
  }

  const fork = await detectForkTopology(cwd)

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
  } else {
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
  }

  return blockStopObj(reason)
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
