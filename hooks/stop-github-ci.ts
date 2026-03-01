#!/usr/bin/env bun
// Stop hook: Block stop if GitHub CI checks are pending or failing

import {
  blockStop,
  ghJson,
  git,
  hasGhCli,
  isGitHubRemote,
  isGitRepo,
  type StopHookInput,
  skillAdvice,
} from "./hook-utils.ts"

interface CIRun {
  databaseId: number
  status: string
  conclusion: string
  displayTitle: string
  workflowName: string
  createdAt: string
  event: string
}

async function main(): Promise<void> {
  const input = (await Bun.stdin.json()) as StopHookInput
  const cwd = input.cwd

  if (!(await isGitRepo(cwd))) return
  if (!hasGhCli()) return
  if (!(await isGitHubRemote(cwd))) return

  const branch = await git(["branch", "--show-current"], cwd)
  if (!branch) return
  if (branch === "main" || branch === "master") return

  const runs = await ghJson<CIRun[]>(
    [
      "run",
      "list",
      "--branch",
      branch,
      "--limit",
      "5",
      "--json",
      "databaseId,status,conclusion,displayTitle,workflowName,createdAt,event",
    ],
    cwd
  )
  if (!runs?.length) return

  // Exclude automated/downstream runs
  const relevant = runs.filter((r) => r.event !== "dynamic" && r.event !== "workflow_run")

  // Check for active runs
  const active = relevant.filter((r) => r.status === "in_progress" || r.status === "queued")

  // Check for failing runs — group by workflow, take most recent of each
  const byWorkflow = new Map<string, CIRun>()
  for (const run of relevant) {
    const existing = byWorkflow.get(run.workflowName)
    if (!existing || run.createdAt > existing.createdAt) {
      byWorkflow.set(run.workflowName, run)
    }
  }

  const failing = [...byWorkflow.values()].filter(
    (r) =>
      r.status === "completed" &&
      (r.conclusion === "failure" ||
        r.conclusion === "timed_out" ||
        r.conclusion === "action_required")
  )

  if (failing.length > 0) {
    const names = failing.map((r) => `${r.workflowName} (${r.conclusion})`).join(", ")
    let reason = `GitHub CI is failing on branch '${branch}'.\n\n`
    reason += `Failing checks (${failing.length}): ${names}\n\n`
    reason += "To view failure logs:\n"
    for (const r of failing) reason += `  gh run view ${r.databaseId} --log-failed\n`
    reason +=
      "\n" +
      skillAdvice(
        "ci-status",
        "Use the /ci-status skill to analyze failures and fix them before stopping.",
        "Analyze CI failures and fix them before stopping. View logs with:\n  gh run view <run-id> --log-failed"
      )
    blockStop(reason)
  }

  if (active.length > 0) {
    const names = active.map((r) => `${r.workflowName} (${r.status})`).join(", ")
    let reason = `GitHub CI is still running on branch '${branch}'.\n\n`
    reason += `Active checks (${active.length}): ${names}\n\n`
    reason += skillAdvice(
      "ci-status",
      "Wait for CI to complete, then check results with the /ci-status skill.",
      `Wait for CI to complete, then check results:\n  gh run list --branch ${branch}`
    )
    blockStop(reason)
  }
}

main()
