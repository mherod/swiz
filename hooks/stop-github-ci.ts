#!/usr/bin/env bun
// Stop hook: Block stop if GitHub CI checks are pending or failing.
// When CI is in_progress, polls up to MAX_POLL_MS before blocking — avoids
// false-positive blocks for short CI runs that complete within seconds.

import { getEffectiveSwizSettings, readSwizSettings } from "../src/settings.ts"
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

const POLL_INTERVAL_MS = 5_000
const MAX_POLL_MS = 30_000

interface CIRun {
  databaseId: number
  status: string
  conclusion: string
  displayTitle: string
  workflowName: string
  createdAt: string
  event: string
}

async function fetchRuns(branch: string, cwd: string): Promise<CIRun[]> {
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
  return (runs ?? []).filter((r) => r.event !== "dynamic" && r.event !== "workflow_run")
}

export function findActive(runs: CIRun[]): CIRun[] {
  return runs.filter((r) => r.status === "in_progress" || r.status === "queued")
}

export function findFailing(runs: CIRun[]): CIRun[] {
  const byWorkflow = new Map<string, CIRun>()
  for (const run of runs) {
    const existing = byWorkflow.get(run.workflowName)
    if (!existing || run.createdAt > existing.createdAt) {
      byWorkflow.set(run.workflowName, run)
    }
  }
  return [...byWorkflow.values()].filter(
    (r) =>
      r.status === "completed" &&
      (r.conclusion === "failure" ||
        r.conclusion === "timed_out" ||
        r.conclusion === "action_required")
  )
}

async function main(): Promise<void> {
  const input = (await Bun.stdin.json()) as StopHookInput
  const cwd = input.cwd

  if (!(await isGitRepo(cwd))) return

  const settings = await readSwizSettings()
  const effective = getEffectiveSwizSettings(settings, input.session_id)
  if (!effective.githubCiGate) return

  if (!hasGhCli()) return
  if (!(await isGitHubRemote(cwd))) return

  const branch = await git(["branch", "--show-current"], cwd)
  if (!branch) return
  if (branch === "main" || branch === "master") return

  let relevant = await fetchRuns(branch, cwd)
  if (!relevant.length) return

  // If runs are active, poll until they complete or the timeout expires.
  // This avoids blocking on CI that will finish within seconds.
  if (findActive(relevant).length > 0) {
    const deadline = Date.now() + MAX_POLL_MS
    while (Date.now() < deadline && findActive(relevant).length > 0) {
      await Bun.sleep(POLL_INTERVAL_MS)
      relevant = await fetchRuns(branch, cwd)
    }
  }

  const failing = findFailing(relevant)
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

  const stillActive = findActive(relevant)
  if (stillActive.length > 0) {
    const names = stillActive.map((r) => `${r.workflowName} (${r.status})`).join(", ")
    let reason = `GitHub CI is still running on branch '${branch}' after waiting ${MAX_POLL_MS / 1000}s.\n\n`
    reason += `Active checks (${stillActive.length}): ${names}\n\n`
    reason += skillAdvice(
      "ci-status",
      "Wait for CI to complete, then check results with the /ci-status skill.",
      `Wait for CI to complete, then check results:\n  gh run list --branch ${branch}`
    )
    blockStop(reason)
  }
}

if (import.meta.main) main()
