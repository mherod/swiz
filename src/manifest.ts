// Agent-agnostic hook manifest.
// Single source of truth for all hook scripts and event bindings.
// install.ts uses it to generate agent configs; dispatch.ts uses it at runtime.

export interface HookDef {
  file: string
  timeout?: number
  async?: boolean
}

export interface HookGroup {
  event: string
  matcher?: string
  hooks: HookDef[]
}

export const manifest: HookGroup[] = [
  {
    event: "stop",
    hooks: [
      { file: "stop-secret-scanner.ts", timeout: 10 },
      { file: "stop-debug-statements.ts", timeout: 10 },
      { file: "stop-large-files.ts", timeout: 10 },
      { file: "stop-git-status.ts", timeout: 10 },
      { file: "stop-lockfile-drift.ts", timeout: 10 },
      { file: "stop-lint-staged.ts", timeout: 30 },
      { file: "stop-branch-conflicts.ts", timeout: 10 },
      { file: "stop-pr-description.ts", timeout: 10 },
      { file: "stop-pr-changes-requested.ts", timeout: 10 },
      { file: "stop-github-ci.ts", timeout: 15 },
      { file: "stop-todo-tracker.ts", timeout: 10 },
      { file: "stop-completion-auditor.ts", timeout: 10 },
      { file: "stop-personal-repo-issues.ts", timeout: 10 },
      { file: "stop-auto-continue.ts", timeout: 120 },
    ],
  },
  {
    event: "preToolUse",
    matcher: "Task",
    hooks: [{ file: "pretooluse-no-task-delegation.ts", timeout: 5 }],
  },
  {
    event: "preToolUse",
    matcher: "TaskCreate",
    hooks: [{ file: "pretooluse-task-subject-validation.ts", timeout: 5 }],
  },
  {
    event: "preToolUse",
    matcher: "TaskUpdate|TaskGet",
    hooks: [{ file: "pretooluse-task-recovery.ts", timeout: 5 }],
  },
  {
    event: "preToolUse",
    matcher: "Edit|Write|NotebookEdit|Bash",
    hooks: [{ file: "pretooluse-update-memory-enforcement.ts", timeout: 5 }],
  },
  {
    event: "preToolUse",
    matcher: "Edit|Write|Bash",
    hooks: [{ file: "pretooluse-require-tasks.ts", timeout: 5 }],
  },
  {
    event: "preToolUse",
    matcher: "Edit|Write|NotebookEdit",
    hooks: [
      { file: "pretooluse-sandboxed-edits.ts", timeout: 5 },
      { file: "pretooluse-json-validation.ts", timeout: 5 },
      { file: "pretooluse-no-direct-deps.ts", timeout: 5 },
      { file: "pretooluse-no-eslint-disable.ts", timeout: 5 },
      { file: "pretooluse-no-ts-ignore.ts", timeout: 5 },
      { file: "pretooluse-eslint-config-strength.ts", timeout: 5 },
      { file: "pretooluse-no-as-any.ts", timeout: 5 },
    ],
  },
  {
    event: "preToolUse",
    matcher: "Bash",
    hooks: [
      { file: "pretooluse-banned-commands.ts", timeout: 5 },
      { file: "pretooluse-no-npm.ts", timeout: 5 },
      { file: "pretooluse-long-sleep.ts", timeout: 5 },
      { file: "pretooluse-commit-checks-gate.ts", timeout: 5 },
      { file: "pretooluse-push-checks-gate.ts", timeout: 5 },
      { file: "pretooluse-push-cooldown.ts", timeout: 5 },
      { file: "pretooluse-main-branch-scope-gate.ts", timeout: 10 },
      { file: "pretooluse-skill-invocation-gate.ts", timeout: 5 },
      { file: "pretooluse-no-push-when-instructed.ts", timeout: 5 },
      { file: "pretooluse-pr-age-gate.ts", timeout: 10 },
    ],
  },
  {
    event: "postToolUse",
    hooks: [{ file: "posttooluse-git-status.ts", timeout: 5 }],
  },
  {
    event: "postToolUse",
    matcher: "TaskCreate",
    hooks: [{ file: "posttooluse-task-subject-validation.ts", timeout: 5 }],
  },
  {
    event: "postToolUse",
    matcher: "TaskUpdate|TaskGet",
    hooks: [{ file: "posttooluse-task-recovery.ts", timeout: 5 }],
  },
  {
    event: "postToolUse",
    matcher: "TaskUpdate",
    hooks: [{ file: "posttooluse-task-evidence.ts", timeout: 5 }],
  },
  {
    event: "postToolUse",
    matcher: "TaskOutput",
    hooks: [{ file: "posttooluse-task-output.ts", timeout: 15 }],
  },
  {
    event: "postToolUse",
    matcher: "Bash",
    hooks: [
      { file: "posttooluse-pr-context.ts", timeout: 10 },
      { file: "posttooluse-git-task-autocomplete.ts", timeout: 5 },
    ],
  },
  {
    event: "postToolUse",
    matcher: "Edit|Write",
    hooks: [
      { file: "posttooluse-json-validation.ts", timeout: 5 },
      { file: "posttooluse-test-pairing.ts", timeout: 5 },
      { file: "posttooluse-task-advisor.ts", timeout: 5 },
      { file: "posttooluse-prettier-ts.ts", timeout: 5, async: true },
    ],
  },
  {
    event: "sessionStart",
    matcher: "startup",
    hooks: [{ file: "sessionstart-health-snapshot.ts", timeout: 10 }],
  },
  {
    event: "sessionStart",
    matcher: "compact",
    hooks: [{ file: "sessionstart-compact-context.ts", timeout: 5 }],
  },
  {
    event: "userPromptSubmit",
    hooks: [
      { file: "userpromptsubmit-git-context.ts", timeout: 5 },
      { file: "userpromptsubmit-task-advisor.ts", timeout: 5 },
    ],
  },
]

// Per-event timeout budget for the dispatcher (seconds).
// Covers worst-case sequential execution of all hooks in that event.
export const DISPATCH_TIMEOUTS: Record<string, number> = {
  stop: 300, // 14 hooks × ~10s avg + 120s AI call (stop-auto-continue)
  preToolUse: 60, // 12 hooks × ~5s avg
  postToolUse: 90, // 8 hooks × ~10s avg
  sessionStart: 20,
  userPromptSubmit: 15,
}
