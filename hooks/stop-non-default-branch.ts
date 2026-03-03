#!/usr/bin/env bun
// Stop hook: Block stop if current branch is not the default branch (main/master).
// Runs late in the manifest so higher-priority blockers (secrets, git state, CI) win first.

import {
  blockStop,
  git,
  isDefaultBranch,
  isGitRepo,
  type StopHookInput,
  skillAdvice,
} from "./hook-utils.ts"

async function main(): Promise<void> {
  const input = (await Bun.stdin.json()) as StopHookInput
  const cwd = input.cwd

  if (!(await isGitRepo(cwd))) return

  const branch = await git(["branch", "--show-current"], cwd)
  if (!branch) return // detached HEAD — not a named branch

  if (isDefaultBranch(branch)) return

  const defaultBranch = "main"
  let reason = `Stopping on feature branch '${branch}' — this likely represents unfinished workflow.\n\n`
  reason += `The session is clean, but the branch itself signals in-progress work. Possible next steps:\n\n`
  reason += `1. Continue work: stay on '${branch}' and complete the task before stopping.\n`
  reason += `2. Open a PR: ${skillAdvice("pr-open", "use the /pr-open skill to create a pull request.", "run: gh pr create --fill")}\n`
  reason += `3. Switch tasks: ${skillAdvice("work-on-issue", "use the /work-on-issue skill to pick up another issue.", "run: git checkout main to return to the default branch.")}\n`
  reason += `4. Return to default: run \`git checkout ${defaultBranch}\` if the branch work is intentionally deferred.\n`

  blockStop(reason)
}

main()
