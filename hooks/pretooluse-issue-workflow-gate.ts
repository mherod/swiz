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
import { hasSkillInSessionLines, hasSkillUsedInProjectRecently } from "../src/skill-utils.ts"
import { isCodeChangeTool, isShellTool } from "../src/tool-matchers.ts"
import { linesAfterLatestUserMessage } from "../src/transcript-utils.ts"
import {
  branchReferenceAliases,
  branchReferencesAlign,
  normalizeBranchReference,
} from "../src/utils/branch-reference.ts"
import { fetchSessionTasksFromDaemon } from "../src/utils/daemon-git-state.ts"
import { git, isGitRepo, preToolUseDeny, skillAdvice } from "../src/utils/hook-utils.ts"
import { readSessionLines } from "../src/utils/transcript.ts"

const WORKFLOW_SKILL = "work-on-issue"
const PR_WORKFLOW_SKILL = "work-on-prs"

/** Task-subject patterns that require a specific skill to be invoked first. */
const TASK_SKILL_GATES: Array<{
  pattern: RegExp
  skill: string
  title: string
  body: string
}> = [
  {
    pattern: /^work\s+on\s+issue\s+#\d+/i,
    skill: WORKFLOW_SKILL,
    title: "Issue workflow required",
    body: "File edits and shell commands are blocked until the issue workflow has been started.",
  },
  {
    pattern: /^push\s+#\d+/i,
    skill: "push",
    title: "Push workflow required",
    body: "File edits and shell commands are blocked until the push workflow has been started.",
  },
]

async function getActiveTasks(
  sessionId: string,
  cwd: string,
  home?: string
): Promise<Array<{ subject: string; status: string }>> {
  const daemonTasks = await fetchSessionTasksFromDaemon(sessionId, cwd)
  // Only trust daemon when it returned actual tasks; empty array means session is
  // unknown to the daemon (not "session exists with no tasks"), so fall back to disk.
  if (daemonTasks?.length) return daemonTasks
  const { readSessionTasks } = await import("../src/tasks/task-recovery.ts")
  return await readSessionTasks(sessionId, home)
}

async function findActiveTaskGate(
  sessionId: string,
  cwd: string,
  home?: string
): Promise<(typeof TASK_SKILL_GATES)[number] | null> {
  const tasks = await getActiveTasks(sessionId, cwd, home)
  const inProgress = tasks.filter((t) => t.status === "in_progress")
  for (const gate of TASK_SKILL_GATES) {
    if (inProgress.some((t) => gate.pattern.test(t.subject))) return gate
  }
  return null
}

function buildMissingSkillMessage(gate: (typeof TASK_SKILL_GATES)[number]): string {
  return (
    `**${gate.title}.**\n\n` +
    `${gate.body}\n\n` +
    skillAdvice(
      gate.skill,
      `Use the /${gate.skill} skill to begin the workflow.`,
      `Run the /${gate.skill} skill before making any changes.`
    )
  )
}

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

const BRANCH_VALUE_PATTERN = "[`'\"<]*([a-zA-Z0-9][a-zA-Z0-9._/-]*)[`'\">]*"

// PR head branch from transcript text (same patterns as pr-head-checkout-gate)
const PR_HEAD_BRANCH_RE = new RegExp(
  "\\b(?:head\\s*=\\s*|head\\s+branch\\s*:\\s*|PR\\s+head\\s*:\\s*|head\\s+ref\\s*:\\s*|headRefName[\"'\\s]*:[\"'\\s]*)" +
    BRANCH_VALUE_PATTERN,
  "i"
)

// Target branch from transcript text.
const TARGET_BRANCH_RE = new RegExp(
  `\\btarget\\s+branch\\b\\s*(?::|=|\\bis\\b)\\s*${BRANCH_VALUE_PATTERN}`,
  "i"
)

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
  return normalizeBranchReference(match[1] ?? "")
}

function scanLines(lines: string[]): ScanResult {
  let inWorkflow = false
  let routedToPrs = false
  let hasFetch = false
  let hasGhActivity = false
  let prHeadBranch: string | null = null
  let targetBranch: string | null = null

  for (const line of linesAfterLatestUserMessage(lines)) {
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
  return (
    GIT_CHECKOUT_PLAIN_RE.test(command) &&
    branchReferenceAliases(branch).some((b) => command.includes(b))
  )
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

export async function evaluateIssueWorkflowGate(
  input: unknown,
  _home?: string
): Promise<SwizHookOutput> {
  const hookInput = toolHookInputSchema.parse(input)
  const cwd = hookInput.cwd ?? process.cwd()
  const toolName = hookInput.tool_name ?? ""
  const transcriptPath = hookInput.transcript_path ?? ""
  const sessionId = String((hookInput as Record<string, unknown>).session_id ?? "")

  const isCodeChange = isCodeChangeTool(toolName)
  const isShell = isShellTool(toolName)

  if (!isCodeChange && !isShell) return {}
  if (!(await isGitRepo(cwd))) return {}
  if (!transcriptPath) return {}

  const command = String((hookInput.tool_input as Record<string, any>)?.command ?? "").normalize(
    "NFKC"
  )

  const lines = await readSessionLines(transcriptPath)
  const { inWorkflow, routedToPrs, hasFetch, hasGhActivity, prHeadBranch, targetBranch } =
    scanLines(lines)

  // Task-subject skill gate — blocks until the required skill is invoked
  if (sessionId) {
    const gate = await findActiveTaskGate(sessionId, cwd, _home)
    if (gate) {
      const resolvedHome = _home ?? process.env.HOME ?? ""
      const skillUsed =
        hasSkillInSessionLines(lines, gate.skill) ||
        (resolvedHome ? await hasSkillUsedInProjectRecently(gate.skill, cwd, resolvedHome) : false)
      if (!skillUsed) {
        return preToolUseDeny(buildMissingSkillMessage(gate))
      }
    }
  }

  // Non-blocked shell commands are exempt from workflow/preflight checks
  if (isShell && !isBlockedBashCommand(command)) return {}
  if (!inWorkflow) return {}

  // AC #1-2: Block until preflight or remote-ref sync evidence exists
  if (!hasFetch && !hasGhActivity) {
    return preToolUseDeny(buildPreflightDenyMessage(toolName))
  }

  const currentBranch = (await git(["branch", "--show-current"], cwd)).trim()
  if (!currentBranch) return {}

  // AC #3: Linked PR found — require PR branch checkout or routing to work-on-prs
  if (prHeadBranch && !branchReferencesAlign(currentBranch, prHeadBranch) && !routedToPrs) {
    if (isShell && isCheckoutToBranch(command, prHeadBranch)) return {}
    return preToolUseDeny(buildLinkedPrDenyMessage(currentBranch, prHeadBranch))
  }

  // AC #4: Target branch declared — require checkout alignment
  if (targetBranch && !branchReferencesAlign(currentBranch, targetBranch)) {
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
