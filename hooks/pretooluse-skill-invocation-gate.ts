#!/usr/bin/env bun

// PreToolUse hook: Block `git commit`, `git push`, and `gh issue edit` label
// operations unless the corresponding skill has been invoked in the current
// session — but only when that skill is installed on this machine.
//
// Rules:
//   git commit                                →  requires /commit skill to have been used this session
//   git push                                  →  requires /push   skill to have been used this session
//   gh issue edit … --add-label triaged       →  requires /triage-issues skill
//   gh issue edit … --remove-label backlog    →  requires /refine-issue skill
//   gh pr create                              →  requires /pr-open skill
//   gh pr review … --dismiss                  →  requires /pr-comments-address skill
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

import { runSwizHookAsMain, type SwizHook, type SwizHookOutput } from "../src/SwizHook.ts"
import { formatSkillReferenceForAgent, skillExists } from "../src/skill-utils.ts"
import { isShellTool, isTaskListTool } from "../src/tool-matchers.ts"
import {
  getSkillsUsedForCurrentSession,
  getToolsUsedForCurrentSession,
} from "../src/transcript-summary.ts"
import {
  GH_ISSUE_ADD_TRIAGED_LABEL_RE,
  GH_ISSUE_REMOVE_BACKLOG_LABEL_RE,
  GH_PR_CREATE_RE,
  GH_PR_REVIEW_DISMISS_RE,
  GIT_COMMIT_RE,
  GIT_PUSH_DELETE_RE,
  GIT_PUSH_RE,
} from "../src/utils/git-utils.ts"
import { preToolUseAllow, preToolUseDeny } from "../src/utils/hook-utils.ts"
import { formatActionPlan } from "../src/utils/inline-hook-helpers.ts"
import { stripQuotedShellStrings } from "../src/utils/shell-patterns.ts"

/** Human-readable line listing Skill-tool invocations for this session (for hook reasons). */
function formatSessionSkillsForReason(skills: string[]): string {
  return `Skills used this session: ${skills.length === 0 ? "(none)" : skills.map((s) => `/${s}`).join(", ")}`
}

const pretoolusSkillInvocationGate: SwizHook = {
  name: "pretooluse-skill-invocation-gate",
  event: "preToolUse",
  matcher: "Bash",
  timeout: 5,

  run: async (rawInput: Record<string, any>): Promise<SwizHookOutput> => {
    const input = rawInput as Record<string, any>
    if (!isShellTool(String(input.tool_name ?? ""))) return {}

    const command: string = ((input.tool_input as Record<string, any>)?.command as string) ?? ""

    // Strip quoted strings for structural pattern matching (gh pr create,
    // gh pr review --dismiss). Label-value patterns (triaged, backlog) must
    // match against the raw command because the label name is typically quoted
    // and would be removed by stripping.
    const cleanedCommand = stripQuotedShellStrings(command)

    // Determine which skill is relevant for this command.
    // - Git commands: raw command (no complex quoted args)
    // - Label operations: raw command (label value is inside quotes)
    // - Structural gh commands: cleanedCommand (quotes hide flags/structure)
    let requiredSkill: string | null = null
    if (GIT_COMMIT_RE.test(command)) requiredSkill = "commit"
    else if (GIT_PUSH_RE.test(command)) {
      // Branch deletion (--delete or :branch) is not a code push — skip gate
      if (GIT_PUSH_DELETE_RE.test(command)) return {}
      requiredSkill = "push"
    } else if (GH_ISSUE_ADD_TRIAGED_LABEL_RE.test(command)) {
      requiredSkill = "triage-issues"
    } else if (GH_ISSUE_REMOVE_BACKLOG_LABEL_RE.test(command)) {
      requiredSkill = "refine-issue"
    } else if (GH_PR_CREATE_RE.test(cleanedCommand)) {
      requiredSkill = "pr-open"
    } else if (GH_PR_REVIEW_DISMISS_RE.test(cleanedCommand)) {
      requiredSkill = "pr-comments-address"
    }

    if (!requiredSkill) return {}

    // Only enforce if the skill is installed on this machine
    if (!skillExists(requiredSkill)) return {}

    // ── Scan transcript for prior skill invocations ───────────────────────────────

    const transcriptPath: string = (input.transcript_path as string) ?? ""
    if (!transcriptPath) return {}

    const invokedSkills = await getSkillsUsedForCurrentSession(input)
    const reason = formatSessionSkillsForReason(invokedSkills)
    const skillReferenceForAgent = formatSkillReferenceForAgent(requiredSkill)

    if (invokedSkills.includes(requiredSkill)) {
      // For commits, also require TaskList to have been called — ensures the
      // task state cache is synced before the commit workflow proceeds.
      if (requiredSkill === "commit") {
        const toolNames = await getToolsUsedForCurrentSession(input)
        if (!toolNames.some((n) => isTaskListTool(n))) {
          return preToolUseDeny(
            "BLOCKED: git commit requires TaskList to have been called first.\n\n" +
              "Call TaskList to sync task state, then retry the commit."
          )
        }
      }
      return preToolUseAllow(
        `${skillReferenceForAgent} skill was invoked in this session.\n${reason}`
      )
    }

    // ── Block with actionable instructions ────────────────────────────────────────

    if (requiredSkill === "triage-issues") {
      return preToolUseDeny(
        `BLOCKED: adding the "triaged" label requires the ${skillReferenceForAgent} skill to be used first.\n\n` +
          `${reason}\n\n` +
          formatActionPlan(
            [`Invoke the ${skillReferenceForAgent} skill before adding the triaged label.`],
            {
              header: `The ${skillReferenceForAgent} skill has not been invoked in this session:`,
            }
          ) +
          `\nWhy this matters: the ${skillReferenceForAgent} skill runs the full triage workflow ` +
          `(repro, severity, owner assignment). Adding the label directly skips these safeguards.`
      )
    }

    if (requiredSkill === "refine-issue") {
      return preToolUseDeny(
        `BLOCKED: removing the "backlog" label requires the ${skillReferenceForAgent} skill to be used first.\n\n` +
          `${reason}\n\n` +
          formatActionPlan(
            [`Invoke the ${skillReferenceForAgent} skill before removing the backlog label.`],
            {
              header: `The ${skillReferenceForAgent} skill has not been invoked in this session:`,
            }
          ) +
          `\nWhy this matters: the ${skillReferenceForAgent} skill validates priority, scope, and readiness before transitioning out of backlog. Removing the label directly skips these safeguards.`
      )
    }

    if (requiredSkill === "pr-open") {
      return preToolUseDeny(
        `BLOCKED: opening a new pull request requires the ${skillReferenceForAgent} skill to be used first.\n\n` +
          `${reason}\n\n` +
          formatActionPlan(
            [`Invoke the ${skillReferenceForAgent} skill before running \`gh pr create\`.`],
            {
              header: `The ${skillReferenceForAgent} skill has not been invoked in this session:`,
            }
          ) +
          `\nWhy this matters: the ${skillReferenceForAgent} skill enforces the complete PR workflow (branch checks, AC verification, linked issues). Running \`gh pr create\` directly skips these safeguards.`
      )
    }

    if (requiredSkill === "pr-comments-address") {
      return preToolUseDeny(
        `BLOCKED: dismissing a pull request review requires the ${skillReferenceForAgent} skill to be used first.\n\n` +
          `${reason}\n\n` +
          formatActionPlan(
            [`Invoke the ${skillReferenceForAgent} skill before dismissing a PR review.`],
            {
              header: `The ${skillReferenceForAgent} skill has not been invoked in this session:`,
            }
          ) +
          `\nWhy this matters: the ${skillReferenceForAgent} skill requires addressing every reviewer comment before dismissal. Dismissing a review directly skips this accountability.`
      )
    }

    const verb = requiredSkill === "commit" ? "commit" : "push"

    return preToolUseDeny(
      `BLOCKED: git ${verb} requires the ${skillReferenceForAgent} skill to be used first.\n\n` +
        `${reason}\n\n` +
        formatActionPlan(
          [`Invoke the ${skillReferenceForAgent} skill before running git ${verb}.`],
          {
            header: `The ${skillReferenceForAgent} skill has not been invoked in this session:`,
          }
        ) +
        `\nWhy this matters: the ${skillReferenceForAgent} skill enforces the complete ` +
        `${verb} workflow (branch checks, task preflight, message format). ` +
        `Running git ${verb} directly skips these safeguards.`
    )
  },
}

export default pretoolusSkillInvocationGate

// ─── Standalone execution (file-based dispatch / manual testing) ────────────
if (import.meta.main) await runSwizHookAsMain(pretoolusSkillInvocationGate)
