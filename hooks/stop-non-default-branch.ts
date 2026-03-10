#!/usr/bin/env bun
// Stop hook: Block stop if current branch is not the default branch.
// Runs late in the manifest so higher-priority blockers (secrets, git state, CI) win first.

import { getEffectiveSwizSettings, readSwizSettings } from "../src/settings.ts"
import {
  blockStop,
  getDefaultBranch,
  git,
  isDefaultBranch,
  isGitRepo,
  skillAdvice,
} from "./hook-utils.ts"
import { stopHookInputSchema } from "./schemas.ts"

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

  let reason = `Stopping on feature branch '${branch}' — this likely represents unfinished workflow.\n\n`
  reason += `The session is clean, but the branch itself signals in-progress work. Possible next steps:\n\n`
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

  blockStop(reason)
}

if (import.meta.main) main()
