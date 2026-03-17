#!/usr/bin/env bun
// PostToolUse hook: After `gh pr create`, checks whether the PR description is
// thin and suggests the /refine-pr skill via additionalContext (non-blocking).

import {
  emitContext,
  GH_PR_CREATE_RE,
  ghJson,
  git,
  hasGhCli,
  isShellTool,
  skillAdvice,
} from "./hook-utils.ts"

const input = await Bun.stdin.json().catch(() => null)
if (!input) process.exit(0)

const toolName: string = input.tool_name ?? ""
const cwd: string = input.cwd ?? process.cwd()
const command: string = input.tool_input?.command ?? ""

if (!isShellTool(toolName) || !command) process.exit(0)
if (!GH_PR_CREATE_RE.test(command)) process.exit(0)
if (!hasGhCli()) process.exit(0)

// Fetch the PR for the current branch
const branch = await git(["branch", "--show-current"], cwd)
if (!branch) process.exit(0)

const pr = await ghJson<{ number: number; title: string; body: string }>(
  ["pr", "view", branch, "--json", "number,title,body"],
  cwd
)
if (!pr?.number) process.exit(0)

const body = (pr.body ?? "").replace(/\s/g, "")
const isThin = !body || body.length < 30

if (!isThin) process.exit(0)

const advice = skillAdvice(
  "refine-pr",
  `PR #${pr.number} was just created with a thin description. Use the /refine-pr skill to populate it with a proper summary, change list, and test plan.`,
  `PR #${pr.number} was just created with a thin description. Consider updating it:\n  gh pr edit ${pr.number} --body "## Summary\\n<description>\\n\\n## Changes\\n- <change 1>"`
)

await emitContext("PostToolUse", advice, cwd)
