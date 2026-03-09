#!/usr/bin/env bun

// PostToolUse hook: Auto-transition project state based on PR lifecycle events.
//
// Transitions:
//   gh pr create  : developing → reviewing
//   gh pr merge   : reviewing → developing
//
// Only transitions if current state matches the expected source state,
// so this is safe to run regardless of workflow or whether PRs are used.

import { readProjectState, writeProjectState } from "../src/settings.ts"
import { GH_PR_CREATE_RE, GH_PR_MERGE_RE, isGitRepo, isShellTool } from "./hook-utils.ts"
import { toolHookInputSchema } from "./schemas.ts"

type ProjectState = "developing" | "reviewing"
type TransitionRule = {
  when: RegExp
  from: ProjectState
  to: ProjectState
}

const TRANSITION_RULES: readonly TransitionRule[] = [
  { when: GH_PR_CREATE_RE, from: "developing", to: "reviewing" },
  { when: GH_PR_MERGE_RE, from: "reviewing", to: "developing" },
]

function detectTransition(command: string): TransitionRule | null {
  for (const rule of TRANSITION_RULES) {
    if (rule.when.test(command)) return rule
  }
  return null
}

async function main(): Promise<void> {
  const input = toolHookInputSchema.parse(await Bun.stdin.json())
  const cwd = input.cwd
  if (!cwd) return

  if (!isShellTool(input.tool_name ?? "")) return
  if (!(await isGitRepo(cwd))) return

  const command = String(input.tool_input?.command ?? "")
  const transition = detectTransition(command)
  if (!transition) return

  const state = await readProjectState(cwd)
  if (state !== transition.from) return

  await writeProjectState(cwd, transition.to)
}

main()
