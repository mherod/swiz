#!/usr/bin/env bun
// Stop hook: Block stop if open PR has empty or placeholder description

import {
  blockStop,
  getDefaultBranch,
  getOpenPrForBranch,
  git,
  hasGhCli,
  isDefaultBranch,
  isGitHubRemote,
  isGitRepo,
  skillAdvice,
} from "./hook-utils.ts"
import { stopHookInputSchema } from "./schemas.ts"

const PLACEHOLDER_PATTERNS = [
  "Describe your changes",
  "What does this PR do",
  "<!-- ",
  "Add a description",
  "[Add description]",
  "Your description here",
]

function blockPrDescription(reason: string): never {
  // PR-description refinement is triage/completion work, not memory-capture follow-through.
  return blockStop(reason, { includeUpdateMemoryAdvice: false })
}

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

async function main(): Promise<void> {
  const input = stopHookInputSchema.parse(await Bun.stdin.json())
  const cwd = input.cwd ?? process.cwd()

  if (!(await isGitRepo(cwd))) return
  if (!hasGhCli()) return
  if (!(await isGitHubRemote(cwd))) return

  const branch = await git(["branch", "--show-current"], cwd)
  if (!branch) return
  const defaultBranch = await getDefaultBranch(cwd)
  if (isDefaultBranch(branch, defaultBranch)) return

  const pr = await getOpenPrForBranch<{ number: number; title: string; body: string }>(
    branch,
    cwd,
    "number,title,body"
  )
  if (!pr) return

  const body = pr.body ?? ""
  const bodyStripped = body.replace(/\s/g, "")

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

  // Empty body
  if (!bodyStripped) {
    blockPrDescription(`PR #${pr.number} ('${pr.title}') has an empty description.\n\n${prAdvice}`)
  }

  // Check for ## Summary placeholder
  if (hasSummaryPlaceholder(body)) {
    blockPrDescription(
      `PR #${pr.number} ('${pr.title}') still contains template placeholder text.\n\n` +
        "Replace the '<...>' placeholder under '## Summary' with actual content before stopping."
    )
  }

  // Check for placeholder patterns
  if (hasPlaceholderPattern(body)) {
    blockPrDescription(
      `PR #${pr.number} ('${pr.title}') still contains template placeholder text.\n\n${prAdvice}`
    )
  }

  // Minimum length
  if (bodyStripped.length < 20) {
    blockPrDescription(
      `PR #${pr.number} ('${pr.title}') description is too short (${bodyStripped.length} chars).\n\n` +
        prAdvice
    )
  }
}

if (import.meta.main) void main()
