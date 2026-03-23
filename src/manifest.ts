// Agent-agnostic hook manifest.
// Single source of truth for all hook scripts and event bindings.
// install.ts uses it to generate agent configs; dispatch.ts uses it at runtime.

import { debugLog } from "./debug.ts"
import { detectFrameworks, type Framework } from "./detect-frameworks.ts"
import type { EffectiveSwizSettings } from "./settings/types.ts"

export interface HookDef {
  file: string
  timeout?: number
  async?: boolean
  /**
   * Minimum seconds between successive deny/block results of this hook (scoped per hook+cwd).
   * The cooldown timer only starts when the hook **denies or blocks** a tool call.
   * If the hook allows the call, no cooldown is recorded and the hook will run
   * again on the next invocation. This prevents repeated blocks while giving the
   * agent time to address the issue.
   */
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
  /**
   * Optional list of settings keys (from EffectiveSwizSettings) that must all
   * be truthy for this hook to run.  Evaluated by the dispatcher before spawning
   * the hook process — when any listed setting is falsy the hook is skipped
   * entirely (zero-cost fast path).
   *
   * Example: `requiredSettings: ["qualityChecksGate"]`
   */
  requiredSettings?: (keyof EffectiveSwizSettings)[]
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

export async function evalCondition(condition: string | undefined): Promise<boolean> {
  if (!condition) return true

  // Framework detection: framework:<name>
  if (condition.startsWith("framework:")) {
    const name = condition.slice("framework:".length)
    if (!VALID_FRAMEWORKS.has(name)) {
      debugLog(`[swiz] Unknown framework in condition: "${name}" — running hook anyway`)
      return true
    }
    const frameworks = await detectFrameworks()
    return frameworks.has(name as Framework)
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
      { file: "stop-offensive-language.ts", timeout: 10 },
      { file: "stop-completion-auditor.ts", timeout: 10 },
      { file: "stop-secret-scanner.ts", timeout: 10 },
      { file: "stop-debug-statements.ts", timeout: 10 },
      { file: "stop-workflow-permissions.ts", timeout: 10 },
      { file: "stop-large-files.ts", timeout: 10 },
      { file: "stop-suppression-patterns.ts", timeout: 10 },
      { file: "stop-git-status.ts", timeout: 10 },
      { file: "stop-lockfile-drift.ts", timeout: 10 },
      { file: "stop-lint-staged.ts", timeout: 30 },
      { file: "stop-quality-checks.ts", timeout: 60, requiredSettings: ["qualityChecksGate"] },
      { file: "stop-branch-conflicts.ts", timeout: 10 },
      { file: "stop-pr-description.ts", timeout: 10 },
      { file: "stop-pr-changes-requested.ts", timeout: 10 },
      { file: "stop-github-ci.ts", timeout: 45 },
      { file: "stop-todo-tracker.ts", timeout: 10 },
      { file: "stop-non-default-branch.ts", timeout: 10 },
      { file: "stop-personal-repo-issues.ts", timeout: 10, cooldownSeconds: 30 },
      { file: "stop-upstream-branch-count.ts", timeout: 10, cooldownSeconds: 7200 },
      { file: "stop-memory-size.ts", timeout: 10 },
      { file: "stop-dependabot-prs.ts", timeout: 10, cooldownSeconds: 3600 },
      { file: "stop-gdpr-data-models.ts", timeout: 10 },
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
    matcher: "TaskUpdate|update_plan",
    hooks: [
      { file: "pretooluse-taskupdate-schema.ts", timeout: 5 },
      { file: "pretooluse-require-task-evidence.ts", timeout: 5 },
      { file: "pretooluse-dirty-worktree-gate.ts", timeout: 5, cooldownSeconds: 60 },
    ],
  },
  {
    event: "preToolUse",
    matcher: "TaskUpdate|TaskGet",
    hooks: [{ file: "pretooluse-task-recovery.ts", timeout: 5 }],
  },
  {
    event: "preToolUse",
    matcher: "TaskOutput",
    hooks: [{ file: "pretooluse-taskoutput-timeout.ts", timeout: 5 }],
  },
  {
    event: "preToolUse",
    matcher: "Edit|Write|NotebookEdit|Bash",
    hooks: [
      { file: "pretooluse-offensive-language.ts", timeout: 5 },
      { file: "pretooluse-update-memory-enforcement.ts", timeout: 5, cooldownSeconds: 300 },
    ],
  },
  {
    event: "preToolUse",
    matcher: "Edit|Write|Bash",
    hooks: [
      { file: "pretooluse-require-tasks.ts", timeout: 5 },
      { file: "pretooluse-state-gate.ts", timeout: 5 },
      { file: "pretooluse-block-preexisting-dismissals.ts", timeout: 5 },
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
      { file: "pretooluse-ts-quality.ts", timeout: 5 },
      { file: "pretooluse-eslint-config-strength.ts", timeout: 5 },
      { file: "pretooluse-no-secrets.ts", timeout: 5 },
      { file: "pretooluse-bun-file-api-enforce.ts", timeout: 5, cooldownSeconds: 30 },
      { file: "pretooluse-bun-spawn-enforce.ts", timeout: 5, cooldownSeconds: 30 },
      { file: "pretooluse-debug-statements.ts", timeout: 5 },
      { file: "pretooluse-todo-tracker.ts", timeout: 5 },
      { file: "pretooluse-large-files.ts", timeout: 5 },
      { file: "pretooluse-workflow-permissions-gate.ts", timeout: 5 },
      { file: "pretooluse-manifest-order-validation.ts", timeout: 5 },
      { file: "pretooluse-claude-md-word-limit.ts", timeout: 5 },
    ],
  },
  {
    event: "preToolUse",
    matcher: "Bash",
    hooks: [
      { file: "pretooluse-no-mixed-tool-calls.ts", timeout: 5 },
      { file: "pretooluse-banned-commands.ts", timeout: 5 },
      { file: "pretooluse-no-merge-conflict-comments.ts", timeout: 5 },
      { file: "pretooluse-no-cp.ts", timeout: 5 },
      { file: "pretooluse-git-index-lock.ts", timeout: 5 },
      { file: "pretooluse-no-npm.ts", timeout: 5 },
      { file: "pretooluse-bun-test-concurrent.ts", timeout: 5 },
      { file: "pretooluse-protect-sandbox.ts", timeout: 5 },
      { file: "pretooluse-protect-strict-main.ts", timeout: 5 },
      { file: "pretooluse-long-sleep.ts", timeout: 5 },
      { file: "pretooluse-commit-checks-gate.ts", timeout: 5 },
      { file: "pretooluse-stale-approval-gate.ts", timeout: 10, cooldownSeconds: 300 },
      { file: "pretooluse-push-checks-gate.ts", timeout: 5 },
      { file: "pretooluse-claude-word-limit.ts", timeout: 5 },
      { file: "pretooluse-push-cooldown.ts", timeout: 5 },
      { file: "pretooluse-main-branch-scope-gate.ts", timeout: 10 },
      { file: "pretooluse-block-commit-to-main.ts", timeout: 10 },
      { file: "pretooluse-pr-changes-branch-guard.ts", timeout: 10 },
      { file: "pretooluse-skill-invocation-gate.ts", timeout: 5 },
      { file: "pretooluse-no-push-when-instructed.ts", timeout: 5 },
      { file: "pretooluse-pr-age-gate.ts", timeout: 10 },
      { file: "pretooluse-repeated-lint-test.ts", timeout: 5, cooldownSeconds: 120 },
    ],
  },
  {
    event: "preToolUse",
    matcher: "Read|Grep|Glob",
    hooks: [{ file: "pretooluse-read-grep-stall-guard.ts", timeout: 5, cooldownSeconds: 300 }],
  },
  {
    event: "postToolUse",
    hooks: [
      { file: "posttooluse-git-status.ts", timeout: 5, cooldownSeconds: 60 },
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
    hooks: [{ file: "posttooluse-task-audit-sync.ts", timeout: 5 }],
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
      { file: "posttooluse-pr-create-refine.ts", timeout: 10 },
      { file: "posttooluse-git-task-autocomplete.ts", timeout: 5 },
      { file: "posttooluse-push-cooldown.ts", timeout: 5 },
      { file: "posttooluse-verify-push.ts", timeout: 20 },
      { file: "posttooluse-state-transition.ts", timeout: 5 },
      { file: "posttooluse-upstream-sync-on-push.ts", timeout: 5 },
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
    hooks: [],
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
    hooks: [{ file: "prpoll-notify.ts", timeout: 15 }],
  },
  {
    event: "preCommit",
    scheduled: true,
    hooks: [{ file: "precommit-staged-validation.ts", timeout: 10 }],
  },
]

// ─── Runtime routing validator ──────────────────────────────────────────────
// Called at dispatch startup and install time to catch manifest/route/agent drift
// before it causes silent misrouting. Throws with actionable fix instructions.

export function validateDispatchRoutes(
  dispatchRoutes: Record<string, string>,
  agents: {
    id: string
    hooksConfigurable: boolean
    eventMap: Record<string, string>
    unsupportedEvents?: string[]
  }[]
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
    const unsupported = new Set(agent.unsupportedEvents ?? [])
    for (const event of agentEvents) {
      if (unsupported.has(event)) continue
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
// Sync hooks run concurrently (Promise.all); budget equals the slowest single hook, not the sum.
export const DISPATCH_TIMEOUTS: Record<string, number> = {
  stop: 180, // dominated by stop-auto-continue AI call (~120s) + stop-github-ci CI polling (~30s)
  preToolUse: 15, // concurrent: budget = slowest hook (~5s) + overhead
  postToolUse: 15, // concurrent: budget = slowest hook (~10s) + overhead
  sessionStart: 20,
  preCompact: 15,
  userPromptSubmit: 15,
  preCommit: 30,
  prPoll: 20,
}
