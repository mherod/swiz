#!/usr/bin/env bun

// PreToolUse hook: Block `git commit`, `git push`, and `gh issue edit` label
// operations unless the corresponding skill has been invoked recently in the
// current session — but only when that skill is installed on this machine.
//
// Rules:
//   git commit                                →  requires recent /commit skill
//   git push                                  →  requires recent /push skill
//   gh issue edit … --add-label triaged       →  requires /triage-issues skill
//   gh issue edit … --add-label/--remove-label →  requires /refine-issue skill
//     UNLESS all changed labels are readiness-only (backlog, ready, blocked,
//     upstream, needs-refinement, needs-breakdown) — those communicate scheduling
//     state, not issue quality, so /refine-issue is not required.
//   gh issue create                           →  NOT gated (label arg is --label,
//     not --add-label; creation is not a label change on an existing issue)
//   gh pr create                              →  requires /pr-open skill
//   gh pr merge                               →  requires /pr-qa-and-merge skill
//   gh pr checkout                            →  requires any of /pr-qa-and-merge,
//     /pr-comments-address, or /work-on-issue
//   gh pr review … --dismiss                  →  requires /pr-comments-address skill
//   swiz tasks complete                       →  requires /swiz-task-governance skill
//
// If the skill is not installed (checked via the same SKILL_DIRS lookup used
// by `src/commands/skill.ts`), the gate is skipped — there is nothing to enforce.
//
// Pattern matching uses two strategies:
//   - Raw `command` for git ops and label-value patterns (label names are quoted)
//   - `stripQuotedShellStrings(command)` for structural gh patterns where quoted
//     args (--jq, --body) can hide flags like --dismiss
//
// Dual-mode: exports a SwizHook for inline dispatch and remains
// executable as a standalone script for backwards compatibility and testing.

import { agentHasTaskListToolForHookPayload } from "../src/agent-paths.ts"
import { checkGitIdentity } from "../src/git-identity.ts"
import { runSwizHookAsMain, type SwizHook, type SwizHookOutput } from "../src/SwizHook.ts"
import { sanitizeSessionId } from "../src/session-id.ts"
import {
  DEFAULT_SKILL_RECENCY_MAX_AGE_MINUTES,
  DEFAULT_SKILL_RECENCY_MAX_TURNS,
  resolveNumericSetting,
} from "../src/settings/resolution.ts"
import {
  type CurrentSessionUsageRecencyOptions,
  formatCurrentSessionUsageWindow,
  formatSkillReferenceForAgent,
  getRecentlyInvokedSkillsForCurrentSession,
  getRecentlyUsedToolsForCurrentSession,
  skillExistsForHookPayload,
  skillGateAgentIdForHookPayload,
} from "../src/skill-utils.ts"
import { skillRequirementCooldownPath } from "../src/temp-paths.ts"
import { isShellTool, isTaskListTool } from "../src/tool-matchers.ts"
import {
  GH_ISSUE_ADD_TRIAGED_LABEL_RE,
  GH_ISSUE_LABEL_CHANGE_RE,
  GH_PR_CHECKOUT_RE,
  GH_PR_CREATE_RE,
  GH_PR_MERGE_RE,
  GH_PR_REVIEW_DISMISS_RE,
  GIT_COMMIT_RE,
  GIT_PUSH_DELETE_RE,
  GIT_PUSH_RE,
} from "../src/utils/git-utils.ts"

const SWIZ_TASKS_COMPLETE_RE = /\bswiz\s+tasks?\s+complete\b/

import { preToolUseAllow, preToolUseDeny } from "../src/utils/hook-utils.ts"
import { formatActionPlan } from "../src/utils/inline-hook-helpers.ts"
import { stripQuotedShellStrings } from "../src/utils/shell-patterns.ts"

/** Labels that communicate scheduling state — not issue quality. Changing only these
 *  labels does not require /refine-issue. */
const READINESS_LABELS = new Set([
  "backlog",
  "ready",
  "blocked",
  "upstream",
  "needs-refinement",
  "needs-breakdown",
])

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

/** Extract all label names from --add-label and --remove-label arguments. */
function extractChangedLabels(command: string): string[] {
  const matches = [...command.matchAll(/--(?:add|remove)-label\s+["']?([^"'\s]+)["']?/g)]
  return matches.flatMap((m) =>
    (m[1] ?? "")
      .split(",")
      .map((l) => l.trim())
      .filter(Boolean)
  )
}

/** Returns true when every changed label is a readiness/scheduling label. */
function allLabelsAreReadinessOnly(labels: string[]): boolean {
  return labels.length > 0 && labels.every((l) => READINESS_LABELS.has(l))
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
  if (GIT_COMMIT_RE.test(command)) return { primary: "commit", anyOf: ["commit"] }
  if (GIT_PUSH_RE.test(command)) {
    if (GIT_PUSH_DELETE_RE.test(command)) return null // branch deletion is not a code push
    return { primary: "push", anyOf: ["push"] }
  }
  if (GH_ISSUE_ADD_TRIAGED_LABEL_RE.test(command))
    return { primary: "triage-issues", anyOf: ["triage-issues"] }
  if (GH_ISSUE_LABEL_CHANGE_RE.test(command)) {
    if (allLabelsAreReadinessOnly(extractChangedLabels(command))) return null
    return { primary: "refine-issue", anyOf: ["refine-issue"] }
  }
  if (GH_PR_CHECKOUT_RE.test(cleanedCommand))
    return {
      primary: "pr-checkout",
      anyOf: ["pr-qa-and-merge", "pr-comments-address", "work-on-issue"],
    }
  if (GH_PR_MERGE_RE.test(cleanedCommand))
    return { primary: "pr-qa-and-merge", anyOf: ["pr-qa-and-merge"] }
  if (GH_PR_CREATE_RE.test(cleanedCommand)) return { primary: "pr-open", anyOf: ["pr-open"] }
  if (GH_PR_REVIEW_DISMISS_RE.test(cleanedCommand))
    return { primary: "pr-comments-address", anyOf: ["pr-comments-address"] }
  if (SWIZ_TASKS_COMPLETE_RE.test(command))
    return { primary: "swiz-task-governance", anyOf: ["swiz-task-governance"] }
  return null
}

/** Format a human-readable skill reference for one or more acceptable skills. */
function formatAnyOfSkillRef(anyOfSkills: string[]): string {
  if (anyOfSkills.length === 1) return formatSkillReferenceForAgent(anyOfSkills[0] ?? "")
  const refs = anyOfSkills.map((s) => formatSkillReferenceForAgent(s))
  const last = refs.at(-1) ?? ""
  return `one of ${refs.slice(0, -1).join(", ")}, or ${last}`
}

/** Per-skill deny message configuration (action phrase, plan step, why-matters). */
const SKILL_DENY_CONFIGS: Record<
  string,
  (ref: string) => { action: string; planStep: string; whyMatters: string }
> = {
  "triage-issues": (ref) => ({
    action: 'adding the "triaged" label',
    planStep: `Invoke the ${ref} skill before adding the triaged label.`,
    whyMatters:
      `the ${ref} skill runs the full triage workflow (repro, severity, owner assignment). ` +
      `Adding the label directly skips these safeguards.`,
  }),
  "refine-issue": (ref) => ({
    action: "changing issue labels",
    planStep: `Invoke the ${ref} skill before modifying issue labels.`,
    whyMatters:
      `the ${ref} skill validates label changes against issue state. ` +
      `Modifying labels directly skips these safeguards.`,
  }),
  "pr-checkout": (ref) => ({
    action: "checking out a pull request branch",
    planStep: `Invoke ${ref} before running \`gh pr checkout\`.`,
    whyMatters:
      `checking out a PR branch without a workflow skill skips PR context loading, ` +
      `review state awareness, and task setup. Use ${ref} to enter the correct workflow.`,
  }),
  "pr-qa-and-merge": (ref) => ({
    action: "merging a pull request",
    planStep: `Invoke the ${ref} skill before running \`gh pr merge\`.`,
    whyMatters:
      `the ${ref} skill enforces the complete merge workflow (CI status, review sign-off, linked issue closure). ` +
      `Running \`gh pr merge\` directly skips these safeguards.`,
  }),
  "pr-open": (ref) => ({
    action: "opening a new pull request",
    planStep: `Invoke the ${ref} skill before running \`gh pr create\`.`,
    whyMatters:
      `the ${ref} skill enforces the complete PR workflow (branch checks, AC verification, linked issues). ` +
      `Running \`gh pr create\` directly skips these safeguards.`,
  }),
  "pr-comments-address": (ref) => ({
    action: "dismissing a pull request review",
    planStep: `Invoke the ${ref} skill before dismissing a PR review.`,
    whyMatters:
      `the ${ref} skill requires addressing every reviewer comment before dismissal. ` +
      `Dismissing a review directly skips this accountability.`,
  }),
  "swiz-task-governance": (ref) => ({
    action: "completing a task via the swiz CLI",
    planStep: `Invoke the ${ref} skill to load task governance rules, then retry.`,
    whyMatters:
      `the ${ref} skill ensures the agent understands the task state machine, evidence requirements, ` +
      `and buffer rules before managing task state via the CLI.`,
  }),
  commit: (ref) => ({
    action: "running git commit",
    planStep: `Invoke the ${ref} skill before running git commit.`,
    whyMatters:
      `the ${ref} skill enforces the complete commit workflow ` +
      `(task preflight, conventional message format, pre-commit hooks). ` +
      `Running git commit directly skips these safeguards.`,
  }),
  push: (ref) => ({
    action: "running git push",
    planStep: `Invoke the ${ref} skill before running git push.`,
    whyMatters:
      `the ${ref} skill enforces the complete push workflow ` +
      `(branch checks, CI readiness, PR state). ` +
      `Running git push directly skips these safeguards.`,
  }),
}

function buildDenyMessage(primary: string, anyOfSkills: string[], reason: string): SwizHookOutput {
  const ref = formatAnyOfSkillRef(anyOfSkills)
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
      `\nWhy this matters: ${whyMatters}`
  )
}

interface GatedCommandCtx {
  primary: string
  anyOfSkills: string[]
}

function resolveGatedCommand(rawInput: Record<string, any>): GatedCommandCtx | null {
  if (!isShellTool(String((rawInput.tool_name as string | undefined) ?? ""))) return null
  const toolInput = (rawInput.tool_input as Record<string, any>) ?? {}
  const command: string = ((toolInput.command as string) ?? (toolInput.cmd as string)) || ""
  const classified = classifyRequiredSkill(command, stripQuotedShellStrings(command))
  if (!classified) return null
  const { primary, anyOf } = classified
  if (!anyOf.some((s) => skillExistsForHookPayload(s, rawInput))) return null
  return { primary, anyOfSkills: anyOf }
}

function requiresTaskListCheck(skill: string, input: Record<string, unknown>): boolean {
  return skill === "commit" && agentHasTaskListToolForHookPayload(input)
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

  const result = await checkGitIdentity(cwd)
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
  if (skill !== "commit") return null
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
    const { primary, anyOfSkills } = ctx

    const cwd: string = (rawInput.cwd as string) ?? process.cwd()
    const preflightBlock = await checkSkillSpecificPreflight(primary, rawInput, cwd)
    if (preflightBlock) return preflightBlock

    const [maxTurns, maxAgeMinutes] = await Promise.all([
      resolveNumericSetting(cwd, "skillRecencyMaxTurns", DEFAULT_SKILL_RECENCY_MAX_TURNS),
      resolveNumericSetting(
        cwd,
        "skillRecencyMaxAgeMinutes",
        DEFAULT_SKILL_RECENCY_MAX_AGE_MINUTES
      ),
    ])
    const recencyOptions: CurrentSessionUsageRecencyOptions = {
      maxTurns,
      maxAgeMs: maxAgeMinutes * 60 * 1000,
    }

    const transcriptPath: string = (rawInput.transcript_path as string) ?? ""
    if (!transcriptPath) return {}

    const invokedSkills = await getRecentlyInvokedSkillsForCurrentSession(rawInput, recencyOptions)
    const reason = formatSessionSkillsForReason(invokedSkills, recencyOptions)

    if (anyOfSkills.some((s) => invokedSkills.includes(s))) {
      const blocked = await checkTaskListRequirement(primary, rawInput, recencyOptions)
      if (blocked) return blocked
      const ref = formatAnyOfSkillRef(anyOfSkills)
      return preToolUseAllow(`${ref} skill was invoked recently.\n${reason}`)
    }

    if (await isSkillRequirementOnCooldown(rawInput, primary)) return {}
    await markSkillRequirementCooldown(rawInput, primary)
    return buildDenyMessage(primary, anyOfSkills, reason)
  },
}

export default pretoolusSkillInvocationGate

// ─── Standalone execution (file-based dispatch / manual testing) ────────────
if (import.meta.main) await runSwizHookAsMain(pretoolusSkillInvocationGate)
