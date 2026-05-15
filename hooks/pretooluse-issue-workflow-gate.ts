#!/usr/bin/env bun

/**
 * PreToolUse hook: In work-on-issue workflows, enforce that:
 * 1. GitHub connectivity or remote-ref sync evidence exists before implementation.
 * 2. If a linked PR is discovered, the worktree matches its head branch (or routes to
 *    work-on-prs).
 * 3. If a target branch is declared, the worktree is on that branch.
 *
 * Dual-mode: SwizToolHook + runSwizHookAsMain.
 */

import { runSwizHookAsMain, type SwizHookOutput, type SwizToolHook } from "../src/SwizHook.ts"
import { toolHookInputSchema } from "../src/schemas.ts"
import { isCodeChangeTool, isShellTool } from "../src/tool-matchers.ts"
import { git, isGitRepo, preToolUseDeny, skillAdvice } from "../src/utils/hook-utils.ts"
import { readSessionLines } from "../src/utils/transcript.ts"

const WORKFLOW_SKILL = "work-on-issue"
const PR_WORKFLOW_SKILL = "work-on-prs"

// Bash commands that are blocked before the workflow preconditions are satisfied
const GIT_COMMIT_RE = /\bgit\s+commit\b/
const GIT_REBASE_RE = /\bgit\s+rebase\b/
const GIT_MERGE_RE = /\bgit\s+merge\b/
const GIT_CHERRY_PICK_RE = /\bgit\s+cherry-pick\b/

// Remote-ref refresh counts as existing-work sync evidence (AC #2)
const GIT_FETCH_RE = /\bgit\s+fetch\b/

// Any gh command that touches issues/PRs/auth counts as GitHub connectivity evidence
const GH_ACTIVITY_RE =
  /\bgh\s+(?:auth\s+status\b|api\s+(?:user\b|repos\/)|issue\s+(?:view|list)\b|pr\s+(?:view|list)\b)/

// git checkout/switch to an existing branch (not -b/-B): alignment commands
const GIT_CHECKOUT_PLAIN_RE = /\bgit\s+(?:checkout|switch)\s+(?!-[bB])\S+/

// PR head branch from transcript text (same patterns as pr-head-checkout-gate)
const PR_HEAD_BRANCH_RE =
  /\b(?:head\s*=\s*|head\s+branch\s*:\s*|PR\s+head\s*:\s*|head\s+ref\s*:\s*|headRefName["'\s]*:["'\s]*)([a-zA-Z0-9._/-]+)/i

// Target branch from transcript text (same pattern as branch-intent-gate)
const TARGET_BRANCH_RE = /\btarget\s+branch[\s:]+([a-zA-Z0-9._/-]+)/i

// ── Transcript scanning ───────────────────────────────────────────────────────

interface ScanResult {
  inWorkflow: boolean
  routedToPrs: boolean
  hasFetch: boolean
  hasGhActivity: boolean
  prHeadBranch: string | null
  targetBranch: string | null
}

function extractBranch(text: string, re: RegExp): string | null {
  const match = re.exec(text)
  if (!match) return null
  const branch = (match[1] ?? "").replace(/["'>]+$/, "").trim()
  return branch.length > 0 ? branch : null
}

function scanLines(lines: string[]): ScanResult {
  let inWorkflow = false
  let routedToPrs = false
  let hasFetch = false
  let hasGhActivity = false
  let prHeadBranch: string | null = null
  let targetBranch: string | null = null

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

    for (const block of content) {
      const b = block as Record<string, any>

      if (b?.type === "tool_use" && b.name === "Skill") {
        const inp = b.input as Record<string, any> | null | undefined
        const skillName = String(inp?.skill ?? "").toLowerCase()
        if (skillName === WORKFLOW_SKILL) inWorkflow = true
        if (skillName === PR_WORKFLOW_SKILL) routedToPrs = true
      }

      if (b?.type === "tool_use" && isShellTool(String(b.name ?? ""))) {
        const cmd = String((b.input as Record<string, any>)?.command ?? "")
        if (GIT_FETCH_RE.test(cmd)) hasFetch = true
        if (GH_ACTIVITY_RE.test(cmd)) hasGhActivity = true
      }

      if (b?.type === "text" && typeof b.text === "string") {
        const prBranch = extractBranch(b.text, PR_HEAD_BRANCH_RE)
        if (prBranch) prHeadBranch = prBranch
        const tb = extractBranch(b.text, TARGET_BRANCH_RE)
        if (tb) targetBranch = tb
      }
    }
  }

  return { inWorkflow, routedToPrs, hasFetch, hasGhActivity, prHeadBranch, targetBranch }
}

// ── Command classification ────────────────────────────────────────────────────

function isBlockedBashCommand(command: string): boolean {
  return (
    GIT_COMMIT_RE.test(command) ||
    GIT_REBASE_RE.test(command) ||
    GIT_MERGE_RE.test(command) ||
    GIT_CHERRY_PICK_RE.test(command)
  )
}

function isCheckoutToBranch(command: string, branch: string): boolean {
  return GIT_CHECKOUT_PLAIN_RE.test(command) && command.includes(branch)
}

// ── Denial messages ───────────────────────────────────────────────────────────

function buildPreflightDenyMessage(toolName: string): string {
  const header =
    `**Issue workflow preflight required.**\n\n` +
    `\`${toolName}\` is blocked: no GitHub connectivity check or remote-ref sync has been ` +
    `found in the transcript yet. The \`work-on-issue\` workflow requires verifying existing ` +
    `work before implementation begins.`

  const steps = [
    "Check GitHub connectivity: `gh auth status && gh api user -q '.login'`",
    "Refresh remote refs: `git fetch origin --prune`",
    "Check for existing PRs: `gh pr list --state open --search '#<issue-number>'`",
    `Retry this \`${toolName}\` call after the existing-work check completes`,
  ]

  const advice = skillAdvice(
    WORKFLOW_SKILL,
    "Use the /work-on-issue skill to run the full preflight sequence.",
    [
      "Run the GitHub connectivity preflight:",
      "  gh auth status",
      "  gh api user -q '.login'",
      "",
      "Refresh remote refs (sync evidence):",
      "  git fetch origin --prune",
      "",
      "Check for existing work:",
      "  gh pr list --state open --search '#<issue-number>'",
      "  git branch -r | grep '<issue-number>'",
    ].join("\n")
  )

  return [header, steps.map((s, i) => `${i + 1}. ${s}`).join("\n"), advice].join("\n\n")
}

function buildLinkedPrDenyMessage(currentBranch: string, prHeadBranch: string): string {
  const header =
    `**Linked PR requires checkout or workflow routing.**\n\n` +
    `Implementation is blocked: a linked PR with head branch \`${prHeadBranch}\` was found ` +
    `but the current branch is \`${currentBranch}\`.`

  const steps = [
    `Route to PR handling: run the \`/work-on-prs\` skill`,
    `Or check out the PR branch: \`git checkout ${prHeadBranch}\``,
    "Retry the blocked operation",
  ]

  const advice = skillAdvice(
    "work-on-prs",
    "Use the /work-on-prs skill to work on the linked PR.",
    [
      "Check out the linked PR branch:",
      `  git checkout ${prHeadBranch}`,
      "",
      "Or fetch and check out:",
      "  git fetch origin",
      `  git checkout ${prHeadBranch}`,
      "",
      "Or use gh pr checkout:",
      "  gh pr checkout <PR-number>",
    ].join("\n")
  )

  return [header, steps.map((s, i) => `${i + 1}. ${s}`).join("\n"), advice].join("\n\n")
}

function buildBranchAlignDenyMessage(currentBranch: string, targetBranch: string): string {
  const header =
    `**Worktree not on the declared target branch.**\n\n` +
    `Implementation is blocked: the transcript declares target branch \`${targetBranch}\` ` +
    `but the current branch is \`${currentBranch}\`.`

  const steps = [
    `Check out the target branch: \`git checkout ${targetBranch}\``,
    "Or create it: `git checkout -b <target> <integration-base>`",
    "Retry the blocked operation",
  ]

  return [header, steps.map((s, i) => `${i + 1}. ${s}`).join("\n")].join("\n\n")
}

// ── Main ─────────────────────────────────────────────────────────────────────

export async function evaluateIssueWorkflowGate(input: unknown): Promise<SwizHookOutput> {
  const hookInput = toolHookInputSchema.parse(input)
  const cwd = hookInput.cwd ?? process.cwd()
  const toolName = hookInput.tool_name ?? ""
  const transcriptPath = hookInput.transcript_path ?? ""

  const isCodeChange = isCodeChangeTool(toolName)
  const isShell = isShellTool(toolName)

  if (!isCodeChange && !isShell) return {}
  if (!(await isGitRepo(cwd))) return {}
  if (!transcriptPath) return {}

  const command = String((hookInput.tool_input as Record<string, any>)?.command ?? "").normalize(
    "NFKC"
  )

  // Quick-exit for shell tools that aren't in the blocked set
  if (isShell && !isBlockedBashCommand(command)) return {}

  const lines = await readSessionLines(transcriptPath)
  const { inWorkflow, routedToPrs, hasFetch, hasGhActivity, prHeadBranch, targetBranch } =
    scanLines(lines)

  if (!inWorkflow) return {}

  // AC #1-2: Block until preflight or remote-ref sync evidence exists
  if (!hasFetch && !hasGhActivity) {
    return preToolUseDeny(buildPreflightDenyMessage(toolName))
  }

  const currentBranch = (await git(["branch", "--show-current"], cwd)).trim()
  if (!currentBranch) return {}

  // AC #3: Linked PR found — require PR branch checkout or routing to work-on-prs
  if (prHeadBranch && currentBranch !== prHeadBranch && !routedToPrs) {
    if (isShell && isCheckoutToBranch(command, prHeadBranch)) return {}
    return preToolUseDeny(buildLinkedPrDenyMessage(currentBranch, prHeadBranch))
  }

  // AC #4: Target branch declared — require checkout alignment
  if (targetBranch && currentBranch !== targetBranch) {
    if (isShell && isCheckoutToBranch(command, targetBranch)) return {}
    return preToolUseDeny(buildBranchAlignDenyMessage(currentBranch, targetBranch))
  }

  return {}
}

const issueWorkflowGate: SwizToolHook = {
  name: "pretooluse-issue-workflow-gate",
  event: "preToolUse",
  timeout: 5,
  run(input) {
    return evaluateIssueWorkflowGate(input)
  },
}

export default issueWorkflowGate

if (import.meta.main) {
  await runSwizHookAsMain(issueWorkflowGate)
}
