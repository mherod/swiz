#!/usr/bin/env bun

/**
 * PreToolUse hook: In work-on-issue and work-on-prs workflows, require the
 * agent to declare the target branch and integration base in the transcript
 * before writing code or creating new branches.
 *
 * Discovery commands (gh issue/pr lookups, read-only git, checkout/switch to
 * align with an existing branch) are always allowed before the declaration.
 * Only code-change tools and branch-creating commands are blocked.
 */

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
import { resolveSessionLines } from "../src/utils/transcript.ts"
import {
  getRepositoryWorkflowHookContext,
  parseAssistantContent,
} from "./repository-workflow-hook-utils.ts"

// Skill names that activate this gate
const WORKFLOW_SKILLS = new Set(["work-on-issue", "work-on-prs"])

// Branch-creating Bash commands that require declaration
// Matches: git checkout -b/-B <name>, git branch <name> (not list flags)
const BRANCH_CREATE_RE = /\bgit\s+(?:checkout\s+-[bB]\b|branch\s+(?!-[a-zA-Z]))/

// Discovery commands always allowed (no declaration needed):
//   - gh issue/pr/api lookups
//   - read-only git: status, log, branch listing, fetch, remote, rev-parse, diff, show
//   - git checkout/switch without -b (aligning to an existing branch)
const DISCOVERY_CMD_RE =
  /\b(?:gh\s+(?:issue|pr|api|run)\b|git\s+(?:status|log\b|branch\b(?:\s+-[a-z])?|fetch\b|remote\b|rev-parse\b|diff\b|show\b|describe\b|ls-remote\b)|git\s+(?:checkout|switch)\s+(?!-[bB])\S)/

// "target branch" declaration: matches "target branch: main", "target branch is main"
const TARGET_BRANCH_RE = /\btarget\s+branch[\s:]+\S+/i

// "integration base" declaration: matches "integration base: main",
// "Likely integration base: main" (standup handoff format)
const INTEGRATION_BASE_RE = /\b(?:likely\s+)?integration\s+base[\s:]+\S+/i

// ── Transcript scanning ───────────────────────────────────────────────────────

interface ScanResult {
  inWorkflow: boolean
  targetDeclared: boolean
  baseDeclared: boolean
}

function extractTextBlocks(content: unknown[]): string[] {
  const out: string[] = []
  for (const block of content) {
    const b = block as Record<string, any>
    if (b?.type === "text" && typeof b.text === "string") {
      out.push(b.text)
    }
  }
  return out
}

function detectSkillInvocation(content: unknown[]): boolean {
  for (const block of content) {
    const b = block as Record<string, any>
    if (b?.type !== "tool_use") continue
    if (b.name !== "Skill") continue
    const inp = b.input as Record<string, any> | null | undefined
    const skillName = String(inp?.skill ?? "").toLowerCase()
    if (WORKFLOW_SKILLS.has(skillName)) return true
  }
  return false
}

function scanLines(lines: string[]): ScanResult {
  const result: ScanResult = {
    inWorkflow: false,
    targetDeclared: false,
    baseDeclared: false,
  }

  for (const line of linesAfterLatestUserMessage(lines)) {
    const content = parseAssistantContent(line)
    if (!content) continue
    if (detectSkillInvocation(content)) result.inWorkflow = true

    for (const text of extractTextBlocks(content)) {
      if (TARGET_BRANCH_RE.test(text)) result.targetDeclared = true
      if (INTEGRATION_BASE_RE.test(text)) result.baseDeclared = true
    }
  }

  return result
}

// ── Command classification ────────────────────────────────────────────────────

/** Returns true when a Bash command is safe to run before declaration. */
function isDiscoveryCommand(command: string): boolean {
  return DISCOVERY_CMD_RE.test(command)
}

/** Returns true when a Bash command creates a new branch (implementation work). */
function isBranchCreateCommand(command: string): boolean {
  return BRANCH_CREATE_RE.test(command)
}

function shellCommandNeedsBranchIntent(command: string): boolean {
  if (isBranchCreateCommand(command)) return true
  if (isDiscoveryCommand(command)) return false
  return false
}

function toolNeedsBranchIntent(toolName: string, command: string): boolean {
  if (isCodeChangeTool(toolName)) return true
  return isShellTool(toolName) && shellCommandNeedsBranchIntent(command)
}

function branchIntentIsSatisfied(result: ScanResult): boolean {
  return result.targetDeclared && result.baseDeclared
}

// ── Denial message ────────────────────────────────────────────────────────────

function buildDenyMessage(toolName: string): string {
  const header =
    `**Branch intent not declared.**\n\n` +
    `${toolName} requires knowing the target branch and integration base before implementation begins.\n\n` +
    `The current session is in a \`work-on-issue\` or \`work-on-prs\` workflow but the transcript does not yet contain:\n` +
    `  - "target branch: <name>" — the branch where changes will be committed\n` +
    `  - "integration base: <name>" — the branch the target branch merges into`

  const steps = [
    "Run the existing-work check: `gh pr list --state open --head $(git branch --show-current)`",
    "Name the target branch and integration base in your task plan (e.g. `TaskUpdate description`)",
    `Retry this ${toolName} call after both are declared in the transcript`,
  ]

  const advice = skillAdvice(
    "work-on-issue",
    "Use the /work-on-issue skill's branch-model preflight to identify the correct branches.",
    [
      "Identify the target branch (existing issue branch, feature branch, or create one from the correct base):",
      "  git branch -r | grep <issue-number>",
      "  gh pr list --search '#<issue-number>' --state open",
      "",
      "Identify the integration base (the branch this will merge into):",
      "  git symbolic-ref refs/remotes/origin/HEAD",
      "  git branch -r | grep -E 'origin/(dev|develop)$'",
      "",
      "Then declare both in your task description before editing files.",
    ].join("\n")
  )

  return [header, steps.map((s, i) => `${i + 1}. ${s}`).join("\n"), advice].join("\n\n")
}

// ── Main ─────────────────────────────────────────────────────────────────────

export async function evaluatePretoolusBranchIntentGate(input: unknown): Promise<SwizHookOutput> {
  const hookInput = toolHookInputSchema.parse(input)
  const { command, cwd, toolName, transcriptPath } = getRepositoryWorkflowHookContext(hookInput)

  if (!toolNeedsBranchIntent(toolName, command)) return {}

  if (!(await isGitRepoForHookPayload(hookInput as Record<string, unknown>, cwd))) return {}
  if (!transcriptPath) return {}

  const lines = await resolveSessionLines(hookInput as Record<string, any>, transcriptPath)
  const { inWorkflow, targetDeclared, baseDeclared } = scanLines(lines)

  if (!inWorkflow) return {}
  if (branchIntentIsSatisfied({ inWorkflow, targetDeclared, baseDeclared })) return {}

  return preToolUseDeny(buildDenyMessage(toolName))
}

const pretoolusBranchIntentGate: SwizToolHook = {
  name: "pretooluse-branch-intent-gate",
  event: "preToolUse",
  timeout: 5,
  run(input) {
    return evaluatePretoolusBranchIntentGate(input)
  },
}

export default pretoolusBranchIntentGate

if (import.meta.main) {
  await runSwizHookAsMain(pretoolusBranchIntentGate)
}
