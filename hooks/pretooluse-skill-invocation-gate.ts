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

import {
  allowPreToolUse,
  denyPreToolUse,
  extractSkillInvocations,
  formatActionPlan,
  GIT_COMMIT_RE,
  GIT_PUSH_RE,
  isShellTool,
  skillExists,
  type ToolHookInput,
} from "./hook-utils.ts"

const input: ToolHookInput = await Bun.stdin.json()
if (!isShellTool(input?.tool_name ?? "")) process.exit(0)

const command: string = (input?.tool_input?.command as string) ?? ""

// Determine which skill is relevant for this command
let requiredSkill: string | null = null
if (GIT_COMMIT_RE.test(command)) requiredSkill = "commit"
else if (GIT_PUSH_RE.test(command)) requiredSkill = "push"

if (!requiredSkill) process.exit(0)

// Only enforce if the skill is installed on this machine
if (!skillExists(requiredSkill)) process.exit(0)

// ── Scan transcript for prior skill invocations ───────────────────────────────

const transcriptPath: string = input?.transcript_path ?? ""
if (!transcriptPath) process.exit(0)

const invokedSkills = await extractSkillInvocations(transcriptPath)

if (invokedSkills.includes(requiredSkill)) {
  allowPreToolUse(`/${requiredSkill} skill was invoked in this session`)
}

// ── Block with actionable instructions ────────────────────────────────────────

const verb = requiredSkill === "commit" ? "commit" : "push"

denyPreToolUse(
  `BLOCKED: git ${verb} requires the /${requiredSkill} skill to be used first.\n\n` +
    formatActionPlan([`Invoke the /${requiredSkill} skill before running git ${verb}.`], {
      header: `The /${requiredSkill} skill has not been invoked in this session:`,
    }) +
    `\nWhy this matters: the /${requiredSkill} skill enforces the complete ` +
    `${verb} workflow (branch checks, task preflight, message format). ` +
    `Running git ${verb} directly skips these safeguards.`
)
