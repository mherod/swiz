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
import { isGitRepo, isShellTool, type ToolHookInput } from "./hook-utils.ts"

const input = (await Bun.stdin.json()) as ToolHookInput
if (!input.tool_name || !isShellTool(input.tool_name)) process.exit(0)

const command = String(input.tool_input?.command ?? "")
const cwd = input.cwd ?? process.cwd()

if (!cwd || !(await isGitRepo(cwd))) process.exit(0)

// Detect PR lifecycle commands at shell statement boundaries
const isPrCreate = /(?:^|;|&&|\|\|)\s*gh pr create\b/.test(command)
const isPrMerge = /(?:^|;|&&|\|\|)\s*gh pr merge\b/.test(command)

if (!isPrCreate && !isPrMerge) process.exit(0)

const state = await readProjectState(cwd)
if (!state) process.exit(0)

if (isPrCreate && state === "developing") {
  await writeProjectState(cwd, "reviewing")
} else if (isPrMerge && state === "reviewing") {
  await writeProjectState(cwd, "developing")
}
