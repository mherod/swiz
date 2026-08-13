#!/usr/bin/env bun

/**
 * PreToolUse hook: In work-on-prs workflows, block PR feedback inspection,
 * file edits, commits, rebases, and merges until the current branch matches
 * the selected PR head branch declared in the transcript.
 *
 * Dual-mode: SwizToolHook + runSwizHookAsMain.
 */

import { git } from "../src/git-helpers.ts"
import { isGitRepoForHookPayload } from "../src/repository-capability.ts"
import {
  preToolUseDeny,
  runSwizHookAsMain,
  type SwizHookOutput,
  type SwizToolHook,
} from "../src/SwizHook.ts"
import { toolHookInputSchema } from "../src/schemas.ts"
import { skillAdvice } from "../src/skill-utils.ts"
import { isCodeChangeTool, isShellTool } from "../src/tool-matchers.ts"
import { linesAfterLatestUserMessage } from "../src/transcript-utils.ts"
import {
  branchReferenceAliases,
  branchReferencesAlign,
  normalizeBranchReference,
} from "../src/utils/branch-reference.ts"
import { resolveSessionLines } from "../src/utils/transcript.ts"
import {
  getRepositoryWorkflowHookContext,
  parseAssistantContent,
} from "./repository-workflow-hook-utils.ts"

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
const BRANCH_VALUE_PATTERN = "[`'\"<]*([a-zA-Z0-9][a-zA-Z0-9._/-]*)[`'\">]*"
const PR_HEAD_BRANCH_RE = new RegExp(
  "\\b(?:head\\s*=\\s*|head\\s+branch\\s*:\\s*|PR\\s+head\\s*:\\s*|head\\s+ref\\s*:\\s*|headRefName[\"'\\s]*:[\"'\\s]*)" +
    BRANCH_VALUE_PATTERN,
  "i"
)

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
  return normalizeBranchReference(match[1] ?? "")
}

function updateScanResult(result: ScanResult, content: unknown[]): void {
  if (detectWorkflowSkill(content)) result.inWorkflow = true

  for (const block of content) {
    const candidate = block as Record<string, any>
    if (candidate?.type !== "text" || typeof candidate.text !== "string") continue
    const branch = extractHeadBranchFromText(candidate.text)
    if (branch) result.prHeadBranch = branch
  }
}

function scanLines(lines: string[]): ScanResult {
  const result: ScanResult = { inWorkflow: false, prHeadBranch: null }

  for (const line of linesAfterLatestUserMessage(lines)) {
    const content = parseAssistantContent(line)
    if (content) updateScanResult(result, content)
  }

  return result
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
  return (
    GIT_CHECKOUT_PLAIN_RE.test(command) &&
    branchReferenceAliases(prHeadBranch).some((branch) => command.includes(branch))
  )
}

function toolNeedsPrHeadAlignment(toolName: string, command: string): boolean {
  if (isCodeChangeTool(toolName)) return true
  return isShellTool(toolName) && isBlockedBashCommand(command)
}

function getDeclaredPrHead(result: ScanResult): string | null {
  if (!result.inWorkflow) return null
  return result.prHeadBranch
}

async function getMisalignedBranches(
  cwd: string,
  prHeadBranch: string
): Promise<{ currentBranch: string; prHeadBranch: string } | null> {
  const currentBranch = (await git(["branch", "--show-current"], cwd)).trim()
  if (!currentBranch || branchReferencesAlign(currentBranch, prHeadBranch)) return null
  return { currentBranch, prHeadBranch }
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
  const { command, cwd, toolName, transcriptPath } = getRepositoryWorkflowHookContext(hookInput)

  if (!toolNeedsPrHeadAlignment(toolName, command)) return {}
  if (!(await isGitRepoForHookPayload(hookInput as Record<string, unknown>, cwd))) return {}
  if (!transcriptPath) return {}

  const lines = await resolveSessionLines(hookInput as Record<string, any>, transcriptPath)
  const prHeadBranch = getDeclaredPrHead(scanLines(lines))
  if (!prHeadBranch) return {}

  const misalignment = await getMisalignedBranches(cwd, prHeadBranch)
  if (!misalignment) return {}

  // Checkout/switch TO the PR head branch is always allowed
  if (isShellTool(toolName) && isCheckoutToPrHead(command, prHeadBranch)) return {}

  return preToolUseDeny(
    buildDenyMessage(misalignment.currentBranch, misalignment.prHeadBranch, toolName)
  )
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
