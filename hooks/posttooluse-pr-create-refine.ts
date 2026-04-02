#!/usr/bin/env bun

// PostToolUse hook: After `gh pr create`, checks whether the PR description is
// thin and suggests the /refine-pr skill via additionalContext (non-blocking).

import type { SwizHook, SwizHookOutput } from "../src/SwizHook.ts"
import { runSwizHookAsMain } from "../src/SwizHook.ts"
import {
  buildContextHookOutput,
  GH_PR_CREATE_RE,
  ghJson,
  git,
  hasGhCli,
  isShellTool,
  skillAdvice,
} from "../src/utils/hook-utils.ts"

function parseCommandInput(input: unknown): { cwd: string; valid: boolean } {
  if (!input || typeof input !== "object") return { cwd: "", valid: false }
  const rec = input as Record<string, any>

  const toolName: string = (rec.tool_name as string) ?? ""
  const cwd: string = (rec.cwd as string) ?? process.cwd()
  const command: string = (rec.tool_input as { command?: string } | undefined)?.command ?? ""

  const valid = isShellTool(toolName) && Boolean(command) && GH_PR_CREATE_RE.test(command)
  return { cwd, valid }
}

async function fetchThinPrNumber(cwd: string): Promise<number | undefined> {
  const branch = await git(["branch", "--show-current"], cwd)
  if (!branch) return undefined

  const pr = await ghJson<{ number: number; title: string; body: string }>(
    ["pr", "view", branch, "--json", "number,title,body"],
    cwd
  )
  if (!pr?.number) return undefined

  const body = (pr.body ?? "").replace(/\s/g, "")
  const isThin = !body || body.length < 30

  if (!isThin) return undefined
  return pr.number
}

export async function evaluatePosttoolusePrCreateRefine(input: unknown): Promise<SwizHookOutput> {
  const { cwd, valid } = parseCommandInput(input)
  if (!valid) return {}
  if (!hasGhCli()) return {}

  const prNumber = await fetchThinPrNumber(cwd)
  if (!prNumber) return {}

  const advice = skillAdvice(
    "refine-pr",
    `PR #${prNumber} was just created with a thin description. Use the /refine-pr skill to populate it with a proper summary, change list, and test plan.`,
    `PR #${prNumber} was just created with a thin description. Consider updating it:\n  gh pr edit ${prNumber} --body "## Summary\\n<description>\\n\\n## Changes\\n- <change 1>"`
  )

  return buildContextHookOutput("PostToolUse", advice)
}

const posttoolusePrCreateRefine: SwizHook<Record<string, any>> = {
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
