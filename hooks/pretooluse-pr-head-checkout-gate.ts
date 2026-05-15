#!/usr/bin/env bun

/**
 * PreToolUse hook: In work-on-prs workflows, block PR feedback inspection,
 * file edits, commits, rebases, and merges until the current branch matches
 * the selected PR head branch declared in the transcript.
 *
 * Dual-mode: SwizToolHook + runSwizHookAsMain.
 */

import { runSwizHookAsMain, type SwizHookOutput, type SwizToolHook } from "../src/SwizHook.ts"
import { toolHookInputSchema } from "../src/schemas.ts"
import { isCodeChangeTool, isShellTool } from "../src/tool-matchers.ts"
import { git, isGitRepo, preToolUseDeny, skillAdvice } from "../src/utils/hook-utils.ts"
import { readSessionLines } from "../src/utils/transcript.ts"

const WORKFLOW_SKILL = "work-on-prs"

// Bash patterns that are blocked when not aligned with the PR head branch
const GIT_COMMIT_RE = /\bgit\s+commit\b/
const GIT_REBASE_RE = /\bgit\s+rebase\b/
const GIT_MERGE_RE = /\bgit\s+merge\b/
const GIT_CHERRY_PICK_RE = /\bgit\s+cherry-pick\b/
const GH_PR_COMMENTS_RE = /\bgh\s+pr\s+view\b.*--comments\b/
const GH_PR_REVIEWS_API_RE = /\bgh\s+api\b.*\/reviews\b/

// git checkout/switch to an existing branch (not -b/-B)
const GIT_CHECKOUT_PLAIN_RE = /\bgit\s+(?:checkout|switch)\s+(?!-[bB])\S+/

// Extracts the PR head branch from transcript text.
// Matches: head=<branch>, head branch: <branch>, PR head: <branch>,
//          headRefName: "<branch>", head ref: <branch>
const PR_HEAD_BRANCH_RE =
  /\b(?:head\s*=\s*|head\s+branch\s*:\s*|PR\s+head\s*:\s*|head\s+ref\s*:\s*|headRefName["'\s]*:["'\s]*)([a-zA-Z0-9._/-]+)/i

// ── Transcript scanning ───────────────────────────────────────────────────────

interface ScanResult {
  inWorkflow: boolean
  prHeadBranch: string | null
}

function detectWorkflowSkill(content: unknown[]): boolean {
  for (const block of content) {
    const b = block as Record<string, any>
    if (b?.type !== "tool_use" || b.name !== "Skill") continue
    const inp = b.input as Record<string, any> | null | undefined
    const skillName = String(inp?.skill ?? "").toLowerCase()
    if (skillName === WORKFLOW_SKILL) return true
  }
  return false
}

function extractHeadBranchFromText(text: string): string | null {
  const match = PR_HEAD_BRANCH_RE.exec(text)
  if (!match) return null
  const branch = (match[1] ?? "").replace(/["'>]+$/, "").trim()
  return branch.length > 0 ? branch : null
}

function scanLines(lines: string[]): ScanResult {
  let inWorkflow = false
  let prHeadBranch: string | null = null

  for (const line of lines) {
    if (!line.trim()) continue
    let entry: Record<string, any>
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (entry?.type !== "assistant") continue
    const content = entry.message?.content
    if (!Array.isArray(content)) continue

    if (detectWorkflowSkill(content)) inWorkflow = true

    for (const block of content) {
      const b = block as Record<string, any>
      if (b?.type === "text" && typeof b.text === "string") {
        const branch = extractHeadBranchFromText(b.text)
        if (branch) prHeadBranch = branch
      }
    }
  }

  return { inWorkflow, prHeadBranch }
}

// ── Command classification ────────────────────────────────────────────────────

function isBlockedBashCommand(command: string): boolean {
  return (
    GIT_COMMIT_RE.test(command) ||
    GIT_REBASE_RE.test(command) ||
    GIT_MERGE_RE.test(command) ||
    GIT_CHERRY_PICK_RE.test(command) ||
    GH_PR_COMMENTS_RE.test(command) ||
    GH_PR_REVIEWS_API_RE.test(command)
  )
}

function isCheckoutToPrHead(command: string, prHeadBranch: string): boolean {
  return GIT_CHECKOUT_PLAIN_RE.test(command) && command.includes(prHeadBranch)
}

// ── Denial message ────────────────────────────────────────────────────────────

function buildDenyMessage(currentBranch: string, prHeadBranch: string, toolName: string): string {
  const header =
    `**PR work requires checking out the PR head branch first.**\n\n` +
    `\`${toolName}\` is blocked: current branch is \`${currentBranch}\` but the selected PR head branch is \`${prHeadBranch}\`.`

  const steps = [
    `Check out the PR head branch: \`git checkout ${prHeadBranch}\``,
    `Verify: \`git branch --show-current\``,
    `Retry the blocked operation`,
  ]

  const advice = skillAdvice(
    "work-on-prs",
    "Use the /work-on-prs skill to align with the PR head branch before making changes.",
    [
      `Switch to the PR head branch:`,
      `  git checkout ${prHeadBranch}`,
      ``,
      `If the branch is not yet local:`,
      `  git fetch origin`,
      `  git checkout ${prHeadBranch}`,
      ``,
      `Or use:`,
      `  gh pr checkout <PR-number>`,
    ].join("\n")
  )

  return [header, steps.map((s, i) => `${i + 1}. ${s}`).join("\n"), advice].join("\n\n")
}

// ── Main ─────────────────────────────────────────────────────────────────────

export async function evaluatePretoolusePrHeadCheckoutGate(
  input: unknown
): Promise<SwizHookOutput> {
  const hookInput = toolHookInputSchema.parse(input)
  const cwd = hookInput.cwd ?? process.cwd()
  const toolName = hookInput.tool_name ?? ""
  const transcriptPath = hookInput.transcript_path ?? ""

  const isCodeChange = isCodeChangeTool(toolName)
  const isShell = isShellTool(toolName)

  if (!isCodeChange && !isShell) return {}
  if (!(await isGitRepo(cwd))) return {}
  if (!transcriptPath) return {}

  // For shell tools, quick-exit if the command is not in the blocked set
  const command = String((hookInput.tool_input as Record<string, any>)?.command ?? "").normalize(
    "NFKC"
  )
  if (isShell && !isBlockedBashCommand(command)) return {}

  const lines = await readSessionLines(transcriptPath)
  const { inWorkflow, prHeadBranch } = scanLines(lines)

  if (!inWorkflow) return {}
  if (!prHeadBranch) return {}

  const currentBranch = (await git(["branch", "--show-current"], cwd)).trim()
  if (!currentBranch) return {}
  if (currentBranch === prHeadBranch) return {}

  // Checkout/switch TO the PR head branch is always allowed
  if (isShell && isCheckoutToPrHead(command, prHeadBranch)) return {}

  return preToolUseDeny(buildDenyMessage(currentBranch, prHeadBranch, toolName))
}

const pretoolusePrHeadCheckoutGate: SwizToolHook = {
  name: "pretooluse-pr-head-checkout-gate",
  event: "preToolUse",
  timeout: 5,
  run(input) {
    return evaluatePretoolusePrHeadCheckoutGate(input)
  },
}

export default pretoolusePrHeadCheckoutGate

if (import.meta.main) {
  await runSwizHookAsMain(pretoolusePrHeadCheckoutGate)
}
