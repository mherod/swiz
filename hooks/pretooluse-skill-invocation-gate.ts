#!/usr/bin/env bun

// PreToolUse hook: Block `git commit` and `git push` unless the corresponding
// skill has been invoked in the current session — but only when that skill
// is installed on this machine.
//
// Rules:
//   git commit  →  requires /commit skill to have been used this session
//   git push    →  requires /push   skill to have been used this session
//
// If the skill is not installed (checked via the same SKILL_DIRS lookup used
// by `src/commands/skill.ts`), the gate is skipped — there is nothing to enforce.
//
// Dual-mode: exports a SwizHook for inline dispatch and remains
// executable as a standalone script for backwards compatibility and testing.

import {
  preToolUseAllow,
  preToolUseDeny,
  runSwizHookAsMain,
  type SwizHook,
} from "../src/SwizHook.ts"
import { skillExists } from "../src/skill-utils.ts"
import { isShellTool, isTaskListTool } from "../src/tool-matchers.ts"
import {
  getSkillsUsedForCurrentSession,
  getToolsUsedForCurrentSession,
} from "../src/transcript-summary.ts"
import { GIT_COMMIT_RE, GIT_PUSH_DELETE_RE, GIT_PUSH_RE } from "../src/utils/git-utils.ts"
import { formatActionPlan } from "../src/utils/inline-hook-helpers.ts"

/** Human-readable line listing Skill-tool invocations for this session (for hook reasons). */
function formatSessionSkillsForReason(skills: string[]): string {
  if (skills.length === 0) return "Skills used this session: (none)"
  return `Skills used this session: ${skills.map((s) => `/${s}`).join(", ")}`
}

const pretoolusSkillInvocationGate: SwizHook = {
  name: "pretooluse-skill-invocation-gate",
  event: "preToolUse",
  matcher: "Bash",
  timeout: 5,

  async run(rawInput) {
    const input = rawInput as Record<string, any>
    if (!isShellTool(String(input.tool_name ?? ""))) return {}

    const command: string = ((input.tool_input as Record<string, any>)?.command as string) ?? ""

    // Determine which skill is relevant for this command
    let requiredSkill: string | null = null
    if (GIT_COMMIT_RE.test(command)) requiredSkill = "commit"
    else if (GIT_PUSH_RE.test(command)) {
      // Branch deletion (--delete or :branch) is not a code push — skip gate
      if (GIT_PUSH_DELETE_RE.test(command)) return {}
      requiredSkill = "push"
    }

    if (!requiredSkill) return {}

    // Only enforce if the skill is installed on this machine
    if (!skillExists(requiredSkill)) return {}

    // ── Scan transcript for prior skill invocations ───────────────────────────────

    const transcriptPath: string = (input.transcript_path as string) ?? ""
    if (!transcriptPath) return {}

    const invokedSkills = await getSkillsUsedForCurrentSession(input)

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
        `/${requiredSkill} skill was invoked in this session.\n${formatSessionSkillsForReason(invokedSkills)}`
      )
    }

    // ── Block with actionable instructions ────────────────────────────────────────

    const verb = requiredSkill === "commit" ? "commit" : "push"

    return preToolUseDeny(
      `BLOCKED: git ${verb} requires the /${requiredSkill} skill to be used first.\n\n` +
        `${formatSessionSkillsForReason(invokedSkills)}\n\n` +
        formatActionPlan([`Invoke the /${requiredSkill} skill before running git ${verb}.`], {
          header: `The /${requiredSkill} skill has not been invoked in this session:`,
        }) +
        `\nWhy this matters: the /${requiredSkill} skill enforces the complete ` +
        `${verb} workflow (branch checks, task preflight, message format). ` +
        `Running git ${verb} directly skips these safeguards.`
    )
  },
}

export default pretoolusSkillInvocationGate

// ─── Standalone execution (file-based dispatch / manual testing) ────────────
if (import.meta.main) await runSwizHookAsMain(pretoolusSkillInvocationGate)
