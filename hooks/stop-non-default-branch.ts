#!/usr/bin/env bun
// Stop hook: Block stop if current branch is not the default branch.
// Runs late in the manifest so higher-priority blockers (secrets, git state, CI) win first.
//
// The agent must finish on the default branch. Being on a feature branch means
// the repository is in a dirty state — even if a PR exists, the agent should
// complete all review tasks, merge the PR, and switch back to main before stopping.

import { getEffectiveSwizSettings, readSwizSettings } from "../src/settings.ts"
import { stopHookInputSchema } from "./schemas.ts"
import {
  blockStop,
  getDefaultBranch,
  getOpenPrForBranch,
  git,
  hasGhCli,
  isDefaultBranch,
  isGitRepo,
  skillAdvice,
} from "./utils/hook-utils.ts"

async function main(): Promise<void> {
  const input = stopHookInputSchema.parse(await Bun.stdin.json())
  const cwd = input.cwd ?? process.cwd()

  if (!(await isGitRepo(cwd))) return

  const settings = await readSwizSettings()
  const effective = getEffectiveSwizSettings(settings, input.session_id)
  if (!effective.nonDefaultBranchGate) return

  const branch = await git(["branch", "--show-current"], cwd)
  if (!branch) return // detached HEAD — not a named branch

  const defaultBranch = await getDefaultBranch(cwd)
  if (isDefaultBranch(branch, defaultBranch)) return

  // Check if the branch has an open PR — tailor guidance accordingly
  let pr: { number: number } | null = null
  if (hasGhCli()) {
    pr = await getOpenPrForBranch<{ number: number }>(branch, cwd, "number")
  }

  let reason = `Stopping on feature branch '${branch}' — the repository must be on '${defaultBranch}' before the session ends.\n\n`

  if (pr) {
    // PR exists — guide the agent through the full completion workflow
    reason += `PR #${pr.number} is open for this branch. Complete the full PR workflow:\n\n`
    reason += `1. Address any review feedback: \`gh pr view ${pr.number} --comments\`\n`
    reason += `2. Fix all lint and typecheck errors on this branch (including pre-existing ones from ${defaultBranch})\n`
    reason += `3. Push fixes: \`git push origin ${branch}\`\n`
    reason += `4. Merge the PR: \`gh pr merge ${pr.number} --squash\`\n`
    reason += `   If merge requires external review: \`gh pr edit ${pr.number} --add-reviewer <handle>\`\n`
    reason += `   If branch protection blocks merge: request review, then switch back to '${defaultBranch}'\n`
    reason += `5. After merge, switch to default branch: \`git checkout ${defaultBranch} && git pull\`\n\n`
    reason += `If you cannot merge (waiting on reviewer), switch back to '${defaultBranch}' anyway:\n`
    reason += `  \`git checkout ${defaultBranch}\`\n`
    reason += `The PR remains open for the reviewer. The session must end on '${defaultBranch}'.\n`
  } else {
    // No PR — original guidance
    reason += `The branch itself signals in-progress work. Possible next steps:\n\n`
    reason += `1. Continue work: stay on '${branch}' and complete the task before stopping.\n`
    const prOpenFallback = [
      `run: gh pr create --fill`,
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

  blockStop(reason)
}

if (import.meta.main) void main()
