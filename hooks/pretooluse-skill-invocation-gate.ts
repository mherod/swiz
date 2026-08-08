#!/usr/bin/env bun

// PreToolUse hook: Block workflow-sensitive shell commands unless the
// corresponding skill has been invoked recently in the current session — but
// only when that skill is installed on this machine.
//
// Rules:
//   git commit                                →  requires recent /commit skill
//   git push                                  →  requires recent /push skill
//   gh issue edit … --add-label triaged       →  requires /triage-issues skill
//   gh issue edit … --add-label/--remove-label →  requires /refine-issue skill
//     (every label change is gated — including readiness/scheduling labels like
//     backlog, ready, or blocked — so label edits always go through refinement)
//   gh issue edit … --add-assignee @me     →  requires /work-on-issue skill
//   gh issue create                           →  NOT gated (label arg is --label,
//     not --add-label; creation is not a label change on an existing issue)
//   gh pr create                              →  requires /pr-open skill
//   gh pr merge                               →  requires /pr-qa-and-merge skill
//                                                 except in trunk mode
//   gh pr checkout                            →  requires any of /pr-qa-and-merge,
//     /pr-comments-address, or /work-on-issue
//   gh pr review … --dismiss                  →  requires /pr-comments-address skill
//
// If the skill is not installed (checked via the same SKILL_DIRS lookup used
// by `src/commands/skill.ts`), the gate is skipped — there is nothing to enforce.
//
// Pattern matching uses two strategies:
//   - Raw `command` only for label-value patterns (label names are quoted)
//   - `stripQuotedShellStrings(command)` for git ops and structural gh patterns,
//     so quoted args (--jq, --body, -m) can't hide/fake a match (e.g. a
//     `gh issue create --body "... git commit ..."` no longer gates on /commit)
//
// Dual-mode: exports a SwizHook for inline dispatch and remains
// executable as a standalone script for backwards compatibility and testing.

import { agentHasTaskListToolForHookPayload } from "../src/agent-paths.ts"
import { GATE_REQUIRED_SKILLS } from "../src/gate-required-skills.ts"
import { checkGitIdentity } from "../src/git-identity.ts"
import {
  preToolUseAllow,
  preToolUseDeny,
  runSwizHookAsMain,
  type SwizHook,
  type SwizHookOutput,
} from "../src/SwizHook.ts"
import { sanitizeSessionId } from "../src/session-id.ts"
import {
  type CurrentSessionUsageRecencyOptions,
  formatCurrentSessionUsageWindow,
  formatSkillFileReadFallback,
  formatSkillReferenceForHookPayload,
  getRecentlyInvokedSkillsForCurrentSession,
  getRecentlyUsedToolsForCurrentSession,
  type ResolvedSkillFile,
  resolveSkillFilePathForHookPayload,
  resolveSkillRecencyOptions,
  skillGateAgentIdForHookPayload,
} from "../src/skill-utils.ts"
import { skillRequirementCooldownPath } from "../src/temp-paths.ts"
import { isShellTool, isTaskListTool } from "../src/tool-matchers.ts"
import {
  GH_ISSUE_ADD_TRIAGED_LABEL_RE,
  GH_ISSUE_LABEL_CHANGE_RE,
  GH_ISSUE_SELF_ASSIGN_RE,
  GH_PR_CHECKOUT_RE,
  GH_PR_CREATE_RE,
  GH_PR_REVIEW_DISMISS_RE,
  GIT_COMMIT_RE,
  GIT_PUSH_DELETE_RE,
  GIT_PUSH_RE,
  isPullRequestMergeCommand,
} from "../src/utils/git-utils.ts"
import { formatActionPlan } from "../src/utils/inline-hook-helpers.ts"
import { stripQuotedShellStrings } from "../src/utils/shell-patterns.ts"

const SKILL_REQUIREMENT_COOLDOWN_MS = 2 * 60 * 1000

function safeCooldownPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "")
}

function skillRequirementCooldownFile(
  input: Record<string, unknown>,
  requiredSkill: string
): string | null {
  const safeSession = sanitizeSessionId(String(input.session_id ?? ""))
  const safeAgent = safeCooldownPart(skillGateAgentIdForHookPayload(input)) || "unknown"
  const safeSkill = safeCooldownPart(requiredSkill)
  if (!safeSession || !safeSkill) return null
  return skillRequirementCooldownPath(safeSession, safeAgent, safeSkill)
}

async function isSkillRequirementOnCooldown(
  input: Record<string, unknown>,
  requiredSkill: string
): Promise<boolean> {
  const path = skillRequirementCooldownFile(input, requiredSkill)
  if (!path) return false
  try {
    const raw = (await Bun.file(path).text()).trim()
    const lastPromptMs = parseInt(raw, 10)
    if (Number.isNaN(lastPromptMs)) return false
    return Date.now() - lastPromptMs < SKILL_REQUIREMENT_COOLDOWN_MS
  } catch {
    return false
  }
}

async function markSkillRequirementCooldown(
  input: Record<string, unknown>,
  requiredSkill: string
): Promise<void> {
  const path = skillRequirementCooldownFile(input, requiredSkill)
  if (!path) return
  await Bun.write(path, String(Date.now())).catch(() => {
    // Non-fatal: if the sentinel write fails, the gate still blocks normally.
  })
}

/** Human-readable line listing Skill-tool invocations for this session (for hook reasons). */
function formatSessionSkillsForReason(
  skills: string[],
  options?: CurrentSessionUsageRecencyOptions
): string {
  const window = formatCurrentSessionUsageWindow(options)
  return `Skills used recently (${window}): ${skills.length === 0 ? "(none)" : skills.map((s) => `/${s}`).join(", ")}`
}

interface SkillRequirement {
  /** Stable key used for deny config lookup, cooldown file, and preflight dispatch. */
  primary: string
  /** Any one of these satisfies the gate. Single-skill rules have one element. */
  anyOf: string[]
}

/**
 * Classify which skill(s) are required for the given shell command.
 * Returns null when no skill gate applies (command is not gated or is exempt).
 */
function classifyRequiredSkill(command: string, cleanedCommand: string): SkillRequirement | null {
  if (GIT_COMMIT_RE.test(cleanedCommand)) {
    const skill = GATE_REQUIRED_SKILLS.commit.name
    return { primary: skill, anyOf: [skill] }
  }
  if (GIT_PUSH_RE.test(cleanedCommand)) {
    if (GIT_PUSH_DELETE_RE.test(cleanedCommand)) return null // branch deletion is not a code push
    const skill = GATE_REQUIRED_SKILLS.push.name
    return { primary: skill, anyOf: [skill] }
  }
  if (GH_ISSUE_ADD_TRIAGED_LABEL_RE.test(command)) {
    const skill = GATE_REQUIRED_SKILLS.triageIssues.name
    return { primary: skill, anyOf: [skill] }
  }
  if (GH_ISSUE_LABEL_CHANGE_RE.test(command)) {
    const skill = GATE_REQUIRED_SKILLS.refineIssue.name
    return { primary: skill, anyOf: [skill] }
  }
  if (GH_ISSUE_SELF_ASSIGN_RE.test(command)) {
    const skill = GATE_REQUIRED_SKILLS.workOnIssue.name
    return { primary: skill, anyOf: [skill] }
  }
  if (GH_PR_CHECKOUT_RE.test(cleanedCommand))
    return {
      primary: "pr-checkout",
      anyOf: [
        GATE_REQUIRED_SKILLS.prQaAndMerge.name,
        GATE_REQUIRED_SKILLS.prCommentsAddress.name,
        GATE_REQUIRED_SKILLS.workOnIssue.name,
      ],
    }
  if (isPullRequestMergeCommand(command)) {
    const skill = GATE_REQUIRED_SKILLS.prQaAndMerge.name
    return { primary: skill, anyOf: [skill] }
  }
  if (GH_PR_CREATE_RE.test(cleanedCommand)) {
    const skill = GATE_REQUIRED_SKILLS.prOpen.name
    return { primary: skill, anyOf: [skill] }
  }
  if (GH_PR_REVIEW_DISMISS_RE.test(cleanedCommand)) {
    const skill = GATE_REQUIRED_SKILLS.prCommentsAddress.name
    return { primary: skill, anyOf: [skill] }
  }
  return null
}

/** Format a human-readable skill reference for one or more acceptable skills. */
function formatAnyOfSkillRef(skills: readonly string[], input: Record<string, unknown>): string {
  if (skills.length === 1) return formatSkillReferenceForHookPayload(skills[0] ?? "", input)
  const refs = skills.map((skill) => formatSkillReferenceForHookPayload(skill, input))
  const last = refs.at(-1) ?? ""
  return `one of ${refs.slice(0, -1).join(", ")}, or ${last}`
}

/** Per-skill deny message configuration (action phrase, plan step, why-matters). */
const SKILL_DENY_CONFIGS: Record<
  string,
  (ref: string) => { action: string; planStep: string; whyMatters: string }
> = {
  [GATE_REQUIRED_SKILLS.triageIssues.name]: (ref) => ({
    action: 'adding the "triaged" label',
    planStep: `Invoke the ${ref} skill before adding the triaged label.`,
    whyMatters:
      `the ${ref} skill runs the full triage workflow (repro, severity, owner assignment). ` +
      `Adding the label directly skips these safeguards.`,
  }),
  [GATE_REQUIRED_SKILLS.refineIssue.name]: (ref) => ({
    action: "changing issue labels",
    planStep: `Invoke the ${ref} skill before modifying issue labels.`,
    whyMatters:
      `the ${ref} skill validates label changes against issue state. ` +
      `Modifying labels directly skips these safeguards.`,
  }),
  [GATE_REQUIRED_SKILLS.workOnIssue.name]: (ref) => ({
    action: "assigning yourself to an issue",
    planStep: `Invoke the ${ref} skill before claiming issue ownership.`,
    whyMatters:
      `the ${ref} skill loads issue context, checks for existing work, and sets up the task workflow. ` +
      `Claiming an issue directly skips those safeguards.`,
  }),
  "pr-checkout": (ref) => ({
    action: "checking out a pull request branch",
    planStep: `Invoke ${ref} before running \`gh pr checkout\`.`,
    whyMatters:
      `checking out a PR branch without a workflow skill skips PR context loading, ` +
      `review state awareness, and task setup. Use ${ref} to enter the correct workflow.`,
  }),
  [GATE_REQUIRED_SKILLS.prQaAndMerge.name]: (ref) => ({
    action: "merging a pull request",
    planStep: `Invoke the ${ref} skill before running \`gh pr merge\`.`,
    whyMatters:
      `the ${ref} skill enforces the complete merge workflow (CI status, review sign-off, linked issue closure). ` +
      `Running \`gh pr merge\` directly skips these safeguards.`,
  }),
  [GATE_REQUIRED_SKILLS.prOpen.name]: (ref) => ({
    action: "opening a new pull request",
    planStep: `Invoke the ${ref} skill before running \`gh pr create\`.`,
    whyMatters:
      `the ${ref} skill enforces the complete PR workflow (branch checks, AC verification, linked issues). ` +
      `Running \`gh pr create\` directly skips these safeguards.`,
  }),
  [GATE_REQUIRED_SKILLS.prCommentsAddress.name]: (ref) => ({
    action: "dismissing a pull request review",
    planStep: `Invoke the ${ref} skill before dismissing a PR review.`,
    whyMatters:
      `the ${ref} skill requires addressing every reviewer comment before dismissal. ` +
      `Dismissing a review directly skips this accountability.`,
  }),
  [GATE_REQUIRED_SKILLS.commit.name]: (ref) => ({
    action: "running git commit",
    planStep: `Invoke the ${ref} skill before running git commit.`,
    whyMatters:
      `the ${ref} skill enforces the complete commit workflow ` +
      `(task preflight, conventional message format, pre-commit hooks). ` +
      `Running git commit directly skips these safeguards.`,
  }),
  [GATE_REQUIRED_SKILLS.push.name]: (ref) => ({
    action: "running git push",
    planStep: `Invoke the ${ref} skill before running git push.`,
    whyMatters:
      `the ${ref} skill enforces the complete push workflow ` +
      `(branch checks, CI readiness, PR state). ` +
      `Running git push directly skips these safeguards.`,
  }),
}

function buildDenyMessage(
  primary: string,
  anyOfSkills: readonly string[],
  skillFiles: readonly ResolvedSkillFile[],
  reason: string,
  input: Record<string, unknown>
): SwizHookOutput {
  const ref = formatAnyOfSkillRef(anyOfSkills, input)
  const isMulti = anyOfSkills.length > 1
  const configFactory = SKILL_DENY_CONFIGS[primary]
  const { action, planStep, whyMatters } = configFactory?.(ref) ?? {
    action: `using ${primary}`,
    planStep: `Invoke ${ref} before continuing.`,
    whyMatters: `${ref} enforces the required workflow. Bypassing it skips these safeguards.`,
  }
  const blockedLine = isMulti
    ? `BLOCKED: ${action} requires ${ref} to have been invoked first.`
    : `BLOCKED: ${action} requires the ${ref} skill to be used first.`
  const planHeader = isMulti
    ? "None of the required skills have been invoked recently:"
    : `The ${ref} skill has not been invoked recently:`
  return preToolUseDeny(
    `${blockedLine}\n\n` +
      `${reason}\n\n` +
      formatActionPlan([planStep], { header: planHeader }) +
      `\n${formatSkillFileReadFallback(skillFiles)}\n` +
      `\nWhy this matters: ${whyMatters}\n\n` +
      `This block is advisory for the next ${Math.round(SKILL_REQUIREMENT_COOLDOWN_MS / 60_000)} minutes — ` +
      `invoke the skill before retrying, don't just retry the same command.`
  )
}

interface GatedCommandCtx {
  primary: string
  anyOfSkills: string[]
  skillFiles: ResolvedSkillFile[]
}

function resolveGatedCommand(rawInput: Record<string, any>): GatedCommandCtx | null {
  if (!isShellTool(String((rawInput.tool_name as string | undefined) ?? ""))) return null
  const toolInput = (rawInput.tool_input as Record<string, any>) ?? {}
  const command: string = ((toolInput.command as string) ?? (toolInput.cmd as string)) || ""
  const classified = classifyRequiredSkill(command, stripQuotedShellStrings(command))
  if (!classified) return null
  const { primary, anyOf } = classified
  const cwd = (rawInput.cwd as string | undefined) ?? process.cwd()
  const skillFiles = anyOf.flatMap((name) => {
    const path = resolveSkillFilePathForHookPayload(name, rawInput, cwd)
    return path ? [{ name, path }] : []
  })
  if (skillFiles.length === 0) return null
  return { primary, anyOfSkills: anyOf, skillFiles }
}

function requiresTaskListCheck(skill: string, input: Record<string, unknown>): boolean {
  return skill === GATE_REQUIRED_SKILLS.commit.name && agentHasTaskListToolForHookPayload(input)
}

function getShellCommand(rawInput: Record<string, any>): string {
  const toolInput = (rawInput.tool_input as Record<string, any>) ?? {}
  return ((toolInput.command as string) ?? (toolInput.cmd as string)) || ""
}

function hasGitCommitIdentityOverride(command: string): boolean {
  return GIT_COMMIT_RE.test(command) && /\s-c\s+user\.(?:name|email)=/i.test(command)
}

async function checkCommitIdentityPreflight(
  input: Record<string, any>,
  cwd: string
): Promise<SwizHookOutput | null> {
  const command = getShellCommand(input)
  if (hasGitCommitIdentityOverride(command)) {
    return preToolUseDeny(
      "BLOCKED: git commit cannot override user.name or user.email with `git -c`.\n\n" +
        "Use the repository or global git config identity for commits, then retry without per-command author overrides."
    )
  }

  const result = await checkGitIdentity(cwd, input)
  if (!result.isGitRepo || result.ok) return null

  return preToolUseDeny(
    "BLOCKED: git commit author identity is not valid.\n\n" +
      `Problems:\n${result.problems.map((problem) => `  - ${problem}`).join("\n")}\n\n` +
      "Fix the repository or global git config user.name/user.email, then retry the commit."
  )
}

async function checkSkillSpecificPreflight(
  skill: string,
  input: Record<string, any>,
  cwd: string
): Promise<SwizHookOutput | null> {
  if (skill !== GATE_REQUIRED_SKILLS.commit.name) return null
  return await checkCommitIdentityPreflight(input, cwd)
}

async function checkTaskListRequirement(
  skill: string,
  input: Record<string, any>,
  recencyOptions: CurrentSessionUsageRecencyOptions
): Promise<SwizHookOutput | null> {
  if (!requiresTaskListCheck(skill, input)) return null
  const toolNames = await getRecentlyUsedToolsForCurrentSession(input, recencyOptions)
  if (toolNames.some((n) => isTaskListTool(n))) return null
  return preToolUseDeny(
    "BLOCKED: git commit requires TaskList to have been called first.\n\n" +
      `Call TaskList to sync task state, then retry the commit. The TaskList call must be within the ${formatCurrentSessionUsageWindow(recencyOptions)}.`
  )
}

const pretoolusSkillInvocationGate: SwizHook = {
  name: "pretooluse-skill-invocation-gate",
  event: "preToolUse",
  matcher: "Bash",
  timeout: 5,

  run: async (rawInput: Record<string, any>): Promise<SwizHookOutput> => {
    const ctx = resolveGatedCommand(rawInput)
    if (!ctx) return {}
    const { primary, anyOfSkills, skillFiles } = ctx

    const effectiveSettings = rawInput._effectiveSettings as { trunkMode?: boolean } | undefined
    if (
      primary === GATE_REQUIRED_SKILLS.prQaAndMerge.name &&
      effectiveSettings?.trunkMode === true
    ) {
      return preToolUseAllow(
        "Continue in trunk-mode merge policy: the merge skill is not required and reviewer approval is not required; GitHub remains authoritative for mergeability, checks, and branch protection."
      )
    }

    const cwd: string = (rawInput.cwd as string) ?? process.cwd()
    const preflightBlock = await checkSkillSpecificPreflight(primary, rawInput, cwd)
    if (preflightBlock) return preflightBlock

    const { recencyOptions } = await resolveSkillRecencyOptions(cwd)

    const transcriptPath: string = (rawInput.transcript_path as string) ?? ""
    if (!transcriptPath) return {}

    const invokedSkills = await getRecentlyInvokedSkillsForCurrentSession(rawInput, recencyOptions)
    const reason = formatSessionSkillsForReason(invokedSkills, recencyOptions)

    if (anyOfSkills.some((skill) => invokedSkills.includes(skill))) {
      const blocked = await checkTaskListRequirement(primary, rawInput, recencyOptions)
      if (blocked) return blocked
      const ref = formatAnyOfSkillRef(anyOfSkills, rawInput)
      return preToolUseAllow(`${ref} skill was invoked recently.\n${reason}`)
    }

    if (await isSkillRequirementOnCooldown(rawInput, primary)) return {}
    await markSkillRequirementCooldown(rawInput, primary)
    return buildDenyMessage(primary, anyOfSkills, skillFiles, reason, rawInput)
  },
}

export default pretoolusSkillInvocationGate

// ─── Standalone execution (file-based dispatch / manual testing) ────────────
if (import.meta.main) await runSwizHookAsMain(pretoolusSkillInvocationGate)
