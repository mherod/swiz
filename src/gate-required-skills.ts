/**
 * Canonical skill names whose absence makes an enforcement hook fail open.
 *
 * Gate implementations consume these entries directly, while `swiz doctor`
 * enumerates the same registry to surface missing installations. Advisory-only
 * skill references are intentionally excluded because their underlying policy
 * still runs when the suggested skill is unavailable.
 */
export interface GateRequiredSkill {
  readonly name: string
  readonly hooks: readonly string[]
}

export const GATE_REQUIRED_SKILLS = {
  commit: {
    name: "commit",
    hooks: ["pretooluse-skill-invocation-gate"],
  },
  push: {
    name: "push",
    hooks: ["pretooluse-skill-invocation-gate"],
  },
  triageIssues: {
    name: "triage-issues",
    hooks: ["pretooluse-skill-invocation-gate"],
  },
  refineIssue: {
    name: "refine-issue",
    hooks: ["pretooluse-skill-invocation-gate"],
  },
  workOnIssue: {
    name: "work-on-issue",
    hooks: ["pretooluse-skill-invocation-gate"],
  },
  prOpen: {
    name: "pr-open",
    hooks: ["pretooluse-skill-invocation-gate"],
  },
  prQaAndMerge: {
    name: "pr-qa-and-merge",
    hooks: ["pretooluse-skill-invocation-gate"],
  },
  prCommentsAddress: {
    name: "pr-comments-address",
    hooks: ["pretooluse-skill-invocation-gate", "pretooluse-pr-comment-read-gate"],
  },
  updateMemory: {
    name: "update-memory",
    hooks: ["pretooluse-claude-md-update-memory-gate", "pretooluse-update-memory-enforcement"],
  },
  generateRequirements: {
    name: "generate-requirements",
    hooks: ["pretooluse-requirements-generate-gate"],
  },
  applyRsc: {
    name: "apply-rsc",
    hooks: ["pretooluse-apply-rsc-gate"],
  },
  convertToKotlin: {
    name: "convert-to-kotlin",
    hooks: ["pretooluse-require-convert-to-kotlin"],
  },
  endOfDay: {
    name: "end-of-day",
    hooks: ["stop-required-skills"],
  },
  farmOutIssues: {
    name: "farm-out-issues",
    hooks: ["stop-required-skills"],
  },
  continueWithTasks: {
    name: "continue-with-tasks",
    hooks: ["stop-required-skills"],
  },
  reflectOnSessionMistakes: {
    name: "reflect-on-session-mistakes",
    hooks: ["stop-required-skills"],
  },
} as const satisfies Record<string, GateRequiredSkill>

export function listGateRequiredSkills(): GateRequiredSkill[] {
  return Object.values(GATE_REQUIRED_SKILLS)
}
