// Agent-agnostic hook manifest.
// Single source of truth for all hook scripts and event bindings.
// install.ts uses it to generate agent configs; dispatch.ts uses it at runtime.

export interface HookDef {
  file: string;
  timeout?: number;
  async?: boolean;
}

export interface HookGroup {
  event: string;
  matcher?: string;
  hooks: HookDef[];
}

export const manifest: HookGroup[] = [
  {
    event: "stop",
    hooks: [
      { file: "stop-secret-scanner.sh", timeout: 10 },
      { file: "stop-debug-statements.sh", timeout: 10 },
      { file: "stop-large-files.sh", timeout: 10 },
      { file: "stop-git-status.sh", timeout: 10 },
      { file: "stop-lockfile-drift.sh", timeout: 10 },
      { file: "stop-lint-staged.sh", timeout: 30 },
      { file: "stop-git-push.sh", timeout: 10 },
      { file: "stop-branch-conflicts.sh", timeout: 10 },
      { file: "stop-pr-description.sh", timeout: 10 },
      { file: "stop-pr-changes-requested.sh", timeout: 10 },
      { file: "stop-github-ci.sh", timeout: 15 },
      { file: "stop-todo-tracker.sh", timeout: 10 },
      { file: "stop-changelog-staleness.sh", timeout: 10 },
      { file: "stop-completion-auditor.sh", timeout: 10 },
      { file: "stop-personal-repo-issues.ts", timeout: 10 },
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
    matcher: "Edit|Write|Bash",
    hooks: [{ file: "pretooluse-require-tasks.ts", timeout: 5 }],
  },
  {
    event: "preToolUse",
    matcher: "Edit|Write|NotebookEdit",
    hooks: [
      { file: "pretooluse-json-validation.ts" },
      { file: "pretooluse-no-direct-deps.ts", timeout: 5 },
      { file: "pretooluse-no-eslint-disable.ts", timeout: 5 },
      { file: "pretooluse-eslint-config-strength.ts", timeout: 5 },
      { file: "pretooluse-no-as-any.ts", timeout: 5 },
    ],
  },
  {
    event: "preToolUse",
    matcher: "Bash",
    hooks: [
      { file: "pretooluse-banned-commands.ts" },
      { file: "pretooluse-no-npm.ts" },
      { file: "pretooluse-long-sleep.ts", timeout: 5 },
    ],
  },
  {
    event: "postToolUse",
    hooks: [{ file: "posttooluse-git-status.sh", timeout: 5 }],
  },
  {
    event: "postToolUse",
    matcher: "TaskCreate",
    hooks: [{ file: "posttooluse-task-subject-validation.ts", timeout: 5 }],
  },
  {
    event: "postToolUse",
    matcher: "Bash",
    hooks: [{ file: "posttooluse-pr-context.ts", timeout: 10 }],
  },
  {
    event: "postToolUse",
    matcher: "Edit|Write",
    hooks: [
      { file: "posttooluse-json-validation.sh" },
      { file: "posttooluse-test-pairing.sh", timeout: 5 },
      { file: "posttooluse-task-advisor.sh", timeout: 5 },
      { file: "posttooluse-prettier-ts.ts", timeout: 5, async: true },
    ],
  },
  {
    event: "sessionStart",
    matcher: "startup",
    hooks: [{ file: "sessionstart-health-snapshot.sh", timeout: 10 }],
  },
  {
    event: "sessionStart",
    matcher: "compact",
    hooks: [{ file: "sessionstart-compact-context.sh", timeout: 5 }],
  },
  {
    event: "userPromptSubmit",
    hooks: [
      { file: "userpromptsubmit-git-context.sh", timeout: 5 },
      { file: "userpromptsubmit-task-advisor.sh", timeout: 5 },
    ],
  },
];

// Per-event timeout budget for the dispatcher (seconds).
// Covers worst-case sequential execution of all hooks in that event.
export const DISPATCH_TIMEOUTS: Record<string, number> = {
  stop: 180,          // 15 hooks × ~12s avg
  preToolUse: 60,     // 11 hooks × ~5s avg
  postToolUse: 90,    // 8 hooks × ~10s avg
  sessionStart: 20,
  userPromptSubmit: 15,
};
