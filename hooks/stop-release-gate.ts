#!/usr/bin/env bun

// Stop hook: Block session stop when project state is 'released' but the
// working tree or task list is not clean.
//
// When state is 'released', the project is expected to be stable:
//   - No uncommitted changes (things would be lost / untracked)
//   - No open tasks (outstanding work contradicts a released state)
//
// If either condition fails, blocks with a numbered action list so the
// agent knows exactly what to fix before stopping.

import { readProjectState } from "../src/settings.ts"
import { blockStop, git, isGitRepo } from "./hook-utils.ts"
import { stopHookInputSchema } from "./schemas.ts"

const input = stopHookInputSchema.parse(await Bun.stdin.json())
const cwd = input.cwd
if (!cwd || !(await isGitRepo(cwd))) process.exit(0)

const state = await readProjectState(cwd)
if (state !== "released") process.exit(0)

const issues: string[] = []

// Check 1: uncommitted changes
const statusOut = await git(["status", "--porcelain"], cwd)
const uncommitted = statusOut.split("\n").filter(Boolean).length
if (uncommitted > 0) {
  issues.push(`Commit or revert ${uncommitted} uncommitted file(s)`)
}

// Check 2: unpushed commits
const unpushed = await git(["log", "origin/HEAD..HEAD", "--oneline"], cwd).catch(() => "")
const unpushedCount = unpushed.split("\n").filter(Boolean).length
if (unpushedCount > 0) {
  issues.push(`Push ${unpushedCount} unpushed commit(s) to remote`)
}

// Check 3: open tasks
const HOME = process.env.HOME ?? "~"
const { join } = await import("node:path")
const { readdir } = await import("node:fs/promises")
const { projectKeyFromCwd } = await import("../src/project-key.ts")
const tasksRoot = join(HOME, ".claude", "tasks")
const projectsRoot = join(HOME, ".claude", "projects")

let openTasks = 0
try {
  const key = projectKeyFromCwd(cwd)
  const sessionIds = await readdir(join(projectsRoot, key)).catch(() => [] as string[])
  for (const sessionId of sessionIds) {
    const files = await readdir(join(tasksRoot, sessionId)).catch(() => [] as string[])
    for (const file of files) {
      if (!file.endsWith(".json") || file.startsWith(".")) continue
      try {
        const task = (await Bun.file(join(tasksRoot, sessionId, file)).json()) as {
          status?: string
        }
        if (task.status === "pending" || task.status === "in_progress") openTasks++
      } catch {}
    }
  }
} catch {}

if (openTasks > 0) {
  issues.push(`Complete or cancel ${openTasks} open task(s)`)
}

if (issues.length === 0) process.exit(0)

const numbered = issues.map((issue, i) => `  ${i + 1}. ${issue}`).join("\n")
const reason =
  `Project state is 'released' but the following issues were found:\n\n${numbered}\n\n` +
  `Resolve these before stopping, or transition state with:\n  swiz state set paused`

blockStop(reason, { includeUpdateMemoryAdvice: false })
