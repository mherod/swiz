#!/usr/bin/env bun

// Stop hook: Block stop if open PR has empty or placeholder description
//
// Dual-mode: SwizStopHook for inline dispatch + subprocess via runSwizHookAsMain.

import { runSwizHookAsMain } from "../src/RunSwizHookAsMain.ts"
import type { SwizHookOutput, SwizStopHook } from "../src/SwizHook.ts"
import {
  blockStopObj,
  getDefaultBranch,
  getOpenPrForBranch,
  git,
  hasGhCli,
  isDefaultBranch,
  isGitHubRemote,
  isGitRepo,
  skillAdvice,
} from "../src/utils/hook-utils.ts"
import { type StopHookInput, stopHookInputSchema } from "./schemas.ts"

const PLACEHOLDER_PATTERNS = [
  "Describe your changes",
  "What does this PR do",
  "<!-- ",
  "Add a description",
  "[Add description]",
  "Your description here",
]

function hasSummaryPlaceholder(body: string): boolean {
  const lines = body.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line) continue
    if (/^## Summary/.test(line)) {
      for (let j = i + 1; j < lines.length; j++) {
        const nextLine = lines[j]
        if (!nextLine || nextLine.trim() === "") continue
        return nextLine.trim().startsWith("<")
      }
    }
  }
  return false
}

function hasPlaceholderPattern(body: string): boolean {
  const bodyLower = body.toLowerCase()
  return PLACEHOLDER_PATTERNS.some((p) => bodyLower.includes(p.toLowerCase()))
}

async function fetchOpenPr(
  cwd: string
): Promise<{ number: number; title: string; body: string } | null> {
  if (!(await isGitRepo(cwd))) return null
  if (!hasGhCli()) return null
  if (!(await isGitHubRemote(cwd))) return null
  const branch = await git(["branch", "--show-current"], cwd)
  if (!branch) return null
  const defaultBranch = await getDefaultBranch(cwd)
  if (isDefaultBranch(branch, defaultBranch)) return null
  return await getOpenPrForBranch<{ number: number; title: string; body: string }>(
    branch,
    cwd,
    "number,title,body"
  )
}

function validatePrDescription(
  pr: { number: number; title: string; body: string },
  prAdvice: string
): string | null {
  const body = pr.body ?? ""
  const bodyStripped = body.replace(/\s/g, "")

  if (!bodyStripped) {
    return `PR #${pr.number} ('${pr.title}') has an empty description.\n\n${prAdvice}`
  }
  if (hasSummaryPlaceholder(body)) {
    return (
      `PR #${pr.number} ('${pr.title}') still contains template placeholder text.\n\n` +
      "Replace the '<...>' placeholder under '## Summary' with actual content before stopping."
    )
  }
  if (hasPlaceholderPattern(body)) {
    return `PR #${pr.number} ('${pr.title}') still contains template placeholder text.\n\n${prAdvice}`
  }
  if (bodyStripped.length < 20) {
    return (
      `PR #${pr.number} ('${pr.title}') description is too short (${bodyStripped.length} chars).\n\n` +
      prAdvice
    )
  }
  return null
}

export async function evaluateStopPrDescription(input: StopHookInput): Promise<SwizHookOutput> {
  const parsed = stopHookInputSchema.parse(input)
  const cwd = parsed.cwd ?? process.cwd()

  const pr = await fetchOpenPr(cwd)
  if (!pr) return {}

  const prAdvice = skillAdvice(
    "refine-pr",
    "Use the /refine-pr skill to populate the PR description before stopping.",
    [
      `Update the PR description before stopping:`,
      `  gh pr edit ${pr.number} --body "$(cat <<'EOF'`,
      `## Summary`,
      `<one sentence describing what this PR does>`,
      ``,
      `## Changes`,
      `- <key change 1>`,
      `- <key change 2>`,
      `EOF`,
      `)"`,
    ].join("\n")
  )

  const violation = validatePrDescription(pr, prAdvice)
  if (!violation) return {}

  return blockStopObj(violation, { includeUpdateMemoryAdvice: false })
}

const stopPrDescription: SwizStopHook = {
  name: "stop-pr-description",
  event: "stop",
  timeout: 10,

  run(input) {
    return evaluateStopPrDescription(input)
  },
}

export default stopPrDescription

if (import.meta.main) {
  await runSwizHookAsMain(stopPrDescription)
}
