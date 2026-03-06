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
  type StopHookInput,
  skillAdvice,
} from "./hook-utils.ts"

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

async function main(): Promise<void> {
  const input = (await Bun.stdin.json()) as StopHookInput
  const cwd = input.cwd

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
    `Update the PR description before stopping:\n  gh pr edit ${pr.number} --body "<description>"`
  )

  // Empty body
  if (!bodyStripped) {
    blockPrDescription(`PR #${pr.number} ('${pr.title}') has an empty description.\n\n${prAdvice}`)
  }

  // Check for ## Summary immediately followed by a placeholder
  const lines = body.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line) continue
    if (/^## Summary/.test(line)) {
      // Check next non-blank line
      for (let j = i + 1; j < lines.length; j++) {
        const nextLine = lines[j]
        if (!nextLine || nextLine.trim() === "") continue
        if (nextLine.trim().startsWith("<")) {
          blockPrDescription(
            `PR #${pr.number} ('${pr.title}') still contains template placeholder text.\n\n` +
              "Replace the '<...>' placeholder under '## Summary' with actual content before stopping."
          )
        }
        break
      }
      break
    }
  }

  // Check for placeholder patterns
  const bodyLower = body.toLowerCase()
  for (const pattern of PLACEHOLDER_PATTERNS) {
    if (bodyLower.includes(pattern.toLowerCase())) {
      blockPrDescription(
        `PR #${pr.number} ('${pr.title}') still contains template placeholder text.\n\n${prAdvice}`
      )
    }
  }

  // Minimum length
  if (bodyStripped.length < 20) {
    blockPrDescription(
      `PR #${pr.number} ('${pr.title}') description is too short (${bodyStripped.length} chars).\n\n` +
        prAdvice
    )
  }
}

main()
