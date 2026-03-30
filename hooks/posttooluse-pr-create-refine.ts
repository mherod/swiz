#!/usr/bin/env bun
// PostToolUse hook: After `gh pr create`, checks whether the PR description is
// thin and suggests the /refine-pr skill via additionalContext (non-blocking).

import { runSwizHookAsMain } from "../src/RunSwizHookAsMain.ts"
import type { SwizHook, SwizHookOutput } from "../src/SwizHook.ts"
import {
  buildContextHookOutput,
  GH_PR_CREATE_RE,
  ghJson,
  git,
  hasGhCli,
  isShellTool,
  skillAdvice,
} from "../src/utils/hook-utils.ts"

export async function evaluatePosttoolusePrCreateRefine(input: unknown): Promise<SwizHookOutput> {
  if (!input || typeof input !== "object") return {}
  const rec = input as Record<string, unknown>

  const toolName: string = (rec.tool_name as string) ?? ""
  const cwd: string = (rec.cwd as string) ?? process.cwd()
  const command: string = (rec.tool_input as { command?: string } | undefined)?.command ?? ""

  if (!isShellTool(toolName) || !command) return {}
  if (!GH_PR_CREATE_RE.test(command)) return {}
  if (!hasGhCli()) return {}

  const branch = await git(["branch", "--show-current"], cwd)
  if (!branch) return {}

  const pr = await ghJson<{ number: number; title: string; body: string }>(
    ["pr", "view", branch, "--json", "number,title,body"],
    cwd
  )
  if (!pr?.number) return {}

  const body = (pr.body ?? "").replace(/\s/g, "")
  const isThin = !body || body.length < 30

  if (!isThin) return {}

  const advice = skillAdvice(
    "refine-pr",
    `PR #${pr.number} was just created with a thin description. Use the /refine-pr skill to populate it with a proper summary, change list, and test plan.`,
    `PR #${pr.number} was just created with a thin description. Consider updating it:\n  gh pr edit ${pr.number} --body "## Summary\\n<description>\\n\\n## Changes\\n- <change 1>"`
  )

  return buildContextHookOutput("PostToolUse", advice)
}

const posttoolusePrCreateRefine: SwizHook<Record<string, unknown>> = {
  name: "posttooluse-pr-create-refine",
  event: "postToolUse",
  matcher: "Bash",
  timeout: 10,
  run(input) {
    return evaluatePosttoolusePrCreateRefine(input)
  },
}

export default posttoolusePrCreateRefine

if (import.meta.main) {
  await runSwizHookAsMain(posttoolusePrCreateRefine)
}
