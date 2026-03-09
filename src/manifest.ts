// Agent-agnostic hook manifest.
// Single source of truth for all hook scripts and event bindings.
// install.ts uses it to generate agent configs; dispatch.ts uses it at runtime.

import { debugLog } from "./debug.ts"
import { detectFrameworks, type Framework } from "./detect-frameworks.ts"

export interface HookDef {
  file: string
  timeout?: number
  async?: boolean
  /** Minimum seconds between successive runs of this hook (scoped per hook+cwd). */
  cooldownSeconds?: number
  /**
   * Optional environment-based skip condition. Evaluated before the hook process
   * is spawned; when the condition evaluates to false the hook is skipped entirely.
   *
   * Supported expressions:
   *   `env:<VAR>`           — true when VAR is set to a non-empty string
   *   `env:<VAR>=<value>`   — true when VAR equals value (exact match)
   *   `env:<VAR>!=<value>`  — true when VAR does not equal value
   *
   * Unknown syntax is treated as true (fail-open) with a console warning.
   *
   * Example: `"env:CI!=true"` — skip hook when running in CI
   */
  condition?: string
  /**
   * Optional list of project stacks that activate this hook.
   * When present, the hook only runs when `detectProjectStack(cwd)` returns
   * at least one stack in this list.  Hooks with no `stacks` field run for
   * all projects (backwards-compatible default).
   *
   * Supported stack names: "bun", "node", "go", "python", "ruby", "rust", "java", "php"
   *
   * Example: `stacks: ["bun", "node"]` — skip for Go / Python / Rust projects
   */
  stacks?: string[]
}

/**
 * Evaluate a HookDef `condition` expression against the current environment.
 * Returns `true` (run the hook) when the expression is satisfied or unrecognised.
 * Returns `false` (skip the hook) when the expression is not satisfied.
 */
const VALID_FRAMEWORKS = new Set<string>([
  "nextjs",
  "vite",
  "express",
  "fastify",
  "nestjs",
  "remix",
  "astro",
  "bun-cli",
  "python",
  "go",
  "rust",
  "ruby",
  "java",
  "php",
])

export function evalCondition(condition: string | undefined): boolean {
  if (!condition) return true

  // Framework detection: framework:<name>
  if (condition.startsWith("framework:")) {
    const name = condition.slice("framework:".length)
    if (!VALID_FRAMEWORKS.has(name)) {
      debugLog(`[swiz] Unknown framework in condition: "${name}" — running hook anyway`)
      return true
    }
    return detectFrameworks().has(name as Framework)
  }

  const envMatch = condition.match(/^env:([^!=]+)(!=|=)?(.*)$/)
  if (!envMatch) {
    debugLog(`[swiz] Unknown hook condition syntax: "${condition}" — running hook anyway`)
    return true
  }

  const [, varName, op, expected] = envMatch
  const actual = process.env[varName!] ?? ""

  if (!op) return actual.length > 0
  if (op === "=") return actual === expected
  if (op === "!=") return actual !== expected

  debugLog(`[swiz] Unknown operator in hook condition: "${condition}" — running hook anyway`)
  return true
}

export interface HookGroup {
  event: string
  matcher?: string
  hooks: HookDef[]
  /**
   * When true, this group is dispatched on a schedule (e.g. via a LaunchAgent),
   * not triggered by an agent's hook system. `swiz install` skips scheduled groups
   * when generating agent configs, and agent eventMap validation ignores them.
   */
  scheduled?: boolean
}

export const manifest: HookGroup[] = [
  {
    event: "stop",
    hooks: [
      { file: "stop-completion-auditor.ts", timeout: 10 },
      { file: "stop-secret-scanner.ts", timeout: 10 },
      { file: "stop-debug-statements.ts", timeout: 10 },
      { file: "stop-workflow-permissions.ts", timeout: 10 },
      { file: "stop-large-files.ts", timeout: 10 },
      { file: "stop-suppression-patterns.ts", timeout: 10 },
      { file: "stop-git-status.ts", timeout: 10 },
      { file: "stop-lockfile-drift.ts", timeout: 10 },
      { file: "stop-lint-staged.ts", timeout: 30 },
      { file: "stop-quality-checks.ts", timeout: 60 },
      { file: "stop-branch-conflicts.ts", timeout: 10 },
      { file: "stop-pr-description.ts", timeout: 10 },
      { file: "stop-pr-changes-requested.ts", timeout: 10 },
      { file: "stop-github-ci.ts", timeout: 45 },
      { file: "stop-todo-tracker.ts", timeout: 10 },
      { file: "stop-non-default-branch.ts", timeout: 10 },
      { file: "stop-personal-repo-issues.ts", timeout: 10, cooldownSeconds: 300 },
      { file: "stop-upstream-branch-count.ts", timeout: 10, cooldownSeconds: 7200 },
      { file: "stop-memory-size.ts", timeout: 10 },
      { file: "stop-auto-continue.ts", timeout: 120 },
      { file: "posttooluse-speak-narrator.ts", timeout: 30, async: true },
    ],
  },
  {
    event: "preToolUse",
    hooks: [{ file: "posttooluse-speak-narrator.ts", timeout: 30, async: true }],
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
    matcher: "TaskUpdate",
    hooks: [
      { file: "pretooluse-taskupdate-schema.ts", timeout: 5 },
      { file: "pretooluse-require-task-evidence.ts", timeout: 5 },
    ],
  },
  {
    event: "preToolUse",
    matcher: "TaskUpdate|TaskGet",
    hooks: [{ file: "pretooluse-task-recovery.ts", timeout: 5 }],
  },
  {
    event: "preToolUse",
    matcher: "Edit|Write|NotebookEdit|Bash",
    hooks: [{ file: "pretooluse-update-memory-enforcement.ts", timeout: 5, cooldownSeconds: 300 }],
  },
  {
    event: "preToolUse",
    matcher: "Edit|Write|Bash",
    hooks: [
      { file: "pretooluse-require-tasks.ts", timeout: 5 },
      { file: "pretooluse-state-gate.ts", timeout: 5 },
    ],
  },
  {
    event: "preToolUse",
    matcher: "Edit|Write|NotebookEdit",
    hooks: [
      { file: "pretooluse-sandboxed-edits.ts", timeout: 5 },
      { file: "pretooluse-sandbox-guidance-consolidation.ts", timeout: 5 },
      { file: "pretooluse-json-validation.ts", timeout: 5 },
      { file: "pretooluse-no-direct-deps.ts", timeout: 5 },
      { file: "pretooluse-no-node-modules-edit.ts", timeout: 5 },
      { file: "pretooluse-no-lockfile-edit.ts", timeout: 5 },
      { file: "pretooluse-no-eslint-disable.ts", timeout: 5 },
      { file: "pretooluse-no-ts-ignore.ts", timeout: 5 },
      { file: "pretooluse-eslint-config-strength.ts", timeout: 5 },
      { file: "pretooluse-no-as-any.ts", timeout: 5 },
      { file: "pretooluse-no-secrets.ts", timeout: 5 },
      { file: "pretooluse-debug-statements.ts", timeout: 5 },
      { file: "pretooluse-todo-tracker.ts", timeout: 5 },
      { file: "pretooluse-large-files.ts", timeout: 5 },
      { file: "pretooluse-workflow-permissions-gate.ts", timeout: 5 },
      { file: "pretooluse-claude-md-word-limit.ts", timeout: 5 },
    ],
  },
  {
    event: "preToolUse",
    matcher: "Bash",
    hooks: [
      { file: "pretooluse-banned-commands.ts", timeout: 5 },
      { file: "pretooluse-no-cp.ts", timeout: 5 },
      { file: "pretooluse-git-index-lock.ts", timeout: 5 },
      { file: "pretooluse-no-npm.ts", timeout: 5 },
      { file: "pretooluse-bun-test-concurrent.ts", timeout: 5 },
      { file: "pretooluse-protect-sandbox.ts", timeout: 5 },
      { file: "pretooluse-long-sleep.ts", timeout: 5 },
      { file: "pretooluse-commit-checks-gate.ts", timeout: 5 },
      { file: "pretooluse-stale-approval-gate.ts", timeout: 10, cooldownSeconds: 300 },
      { file: "pretooluse-push-checks-gate.ts", timeout: 5 },
      { file: "pretooluse-claude-word-limit.ts", timeout: 5 },
      { file: "pretooluse-push-cooldown.ts", timeout: 5 },
      { file: "pretooluse-main-branch-scope-gate.ts", timeout: 10 },
      { file: "pretooluse-skill-invocation-gate.ts", timeout: 5 },
      { file: "pretooluse-no-push-when-instructed.ts", timeout: 5 },
      { file: "pretooluse-pr-age-gate.ts", timeout: 10 },
      { file: "pretooluse-repeated-lint-test.ts", timeout: 5 },
    ],
  },
  {
    event: "postToolUse",
    hooks: [
      { file: "posttooluse-git-status.ts", timeout: 5 },
      { file: "posttooluse-speak-narrator.ts", timeout: 30, async: true },
    ],
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
    matcher: "TaskList",
    hooks: [{ file: "posttooluse-task-list-sync.ts", timeout: 5 }],
  },
  {
    event: "postToolUse",
    matcher: "TaskUpdate",
    hooks: [{ file: "posttooluse-task-evidence.ts", timeout: 5 }],
  },
  {
    event: "postToolUse",
    matcher: "TaskUpdate|TaskCreate",
    hooks: [{ file: "posttooluse-task-notify.ts", timeout: 5, async: true }],
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
      { file: "posttooluse-verify-push.ts", timeout: 20 },
      { file: "posttooluse-state-transition.ts", timeout: 5 },
    ],
  },
  {
    event: "postToolUse",
    matcher: "Edit|Write",
    hooks: [
      { file: "posttooluse-json-validation.ts", timeout: 5 },
      { file: "posttooluse-test-pairing.ts", timeout: 5 },
      { file: "posttooluse-task-advisor.ts", timeout: 5 },
      { file: "posttooluse-memory-size.ts", timeout: 5 },
      { file: "posttooluse-prettier-ts.ts", timeout: 5, async: true },
    ],
  },
  {
    event: "sessionStart",
    matcher: "startup",
    hooks: [
      { file: "sessionstart-self-heal.ts", timeout: 15 },
      { file: "sessionstart-health-snapshot.ts", timeout: 10 },
      { file: "sessionstart-state-context.ts", timeout: 5 },
      { file: "posttooluse-speak-narrator.ts", timeout: 30, async: true },
    ],
  },
  {
    event: "sessionStart",
    matcher: "compact",
    hooks: [{ file: "sessionstart-compact-context.ts", timeout: 5 }],
  },
  {
    event: "preCompact",
    hooks: [
      { file: "precompact-task-snapshot.ts", timeout: 5 },
      { file: "precompact-speak.ts", timeout: 10 },
      { file: "posttooluse-speak-narrator.ts", timeout: 30, async: true },
    ],
  },
  {
    event: "userPromptSubmit",
    hooks: [
      { file: "userpromptsubmit-git-context.ts", timeout: 5 },
      { file: "userpromptsubmit-task-advisor.ts", timeout: 5 },
      { file: "posttooluse-speak-narrator.ts", timeout: 30, async: true },
    ],
  },
  {
    event: "notification",
    hooks: [{ file: "notification-swiz-notify.ts", async: true, timeout: 10 }],
  },
  {
    event: "subagentStart",
    hooks: [],
  },
  {
    event: "subagentStop",
    hooks: [],
  },
  {
    event: "sessionEnd",
    hooks: [],
  },
  {
    event: "prPoll",
    scheduled: true,
    hooks: [{ file: "prpoll-notify.ts", timeout: 30 }],
  },
]

// ─── Runtime routing validator ──────────────────────────────────────────────
// Called at dispatch startup and install time to catch manifest/route/agent drift
// before it causes silent misrouting. Throws with actionable fix instructions.

export function validateDispatchRoutes(
  dispatchRoutes: Record<string, string>,
  agents: { id: string; hooksConfigurable: boolean; eventMap: Record<string, string> }[]
): void {
  const manifestEvents = [...new Set(manifest.map((g) => g.event))]
  // Scheduled events are dispatched externally (e.g. LaunchAgent) — not by agent hook systems.
  const agentEvents = [...new Set(manifest.filter((g) => !g.scheduled).map((g) => g.event))]
  const routeEvents = Object.keys(dispatchRoutes)
  const errors: string[] = []

  // 1. Every manifest event must have a dispatch route
  for (const event of manifestEvents) {
    if (!(event in dispatchRoutes)) {
      errors.push(
        `Manifest event "${event}" has no DISPATCH_ROUTES entry. ` +
          `Add it to DISPATCH_ROUTES in src/commands/dispatch.ts.`
      )
    }
  }

  // 2. Every dispatch route must have at least one manifest entry
  for (const event of routeEvents) {
    if (!manifest.some((g) => g.event === event)) {
      errors.push(
        `DISPATCH_ROUTES contains "${event}" but no manifest hooks subscribe to it. ` +
          `Remove it from DISPATCH_ROUTES or add hooks in src/manifest.ts.`
      )
    }
  }

  // 3. Configurable agents must map all non-scheduled manifest events
  for (const agent of agents.filter((a) => a.hooksConfigurable)) {
    for (const event of agentEvents) {
      if (!(event in agent.eventMap)) {
        errors.push(
          `Agent "${agent.id}" is missing eventMap entry for manifest event "${event}". ` +
            `Add "${event}" to the eventMap in src/agents.ts.`
        )
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `Dispatch routing validation failed (${errors.length} error${errors.length > 1 ? "s" : ""}):\n\n` +
        errors.map((e, i) => `  ${i + 1}. ${e}`).join("\n")
    )
  }
}

// Per-event timeout budget for the dispatcher (seconds).
// Covers worst-case sequential execution of all hooks in that event.
export const DISPATCH_TIMEOUTS: Record<string, number> = {
  stop: 360, // 16 hooks × ~10s avg + 120s AI call (stop-auto-continue) + 30s CI polling (stop-github-ci)
  preToolUse: 60, // 12 hooks × ~5s avg
  postToolUse: 90, // 8 hooks × ~10s avg
  sessionStart: 20,
  preCompact: 15,
  userPromptSubmit: 15,
}
