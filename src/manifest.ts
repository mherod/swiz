// Agent-agnostic hook manifest.
// Single source of truth for all hook scripts and event bindings.
// install.ts uses it to generate agent configs; dispatch.ts uses it at runtime.

import precompactSpeak from "../hooks/precompact-speak.ts"
import pretooluseBunTestConcurrent from "../hooks/pretooluse-bun-test-concurrent.ts"
import pretoolusJsonValidation from "../hooks/pretooluse-json-validation.ts"
import pretooluseLongSleep from "../hooks/pretooluse-long-sleep.ts"
import pretoolusNoCp from "../hooks/pretooluse-no-cp.ts"
import pretoolusNoIssueClose from "../hooks/pretooluse-no-issue-close.ts"
import pretoolusNoLockfileEdit from "../hooks/pretooluse-no-lockfile-edit.ts"
import pretoolusNoMergeConflictComments from "../hooks/pretooluse-no-merge-conflict-comments.ts"
import pretoolusNoMixedToolCalls from "../hooks/pretooluse-no-mixed-tool-calls.ts"
import pretoolusNoNodeModulesEdit from "../hooks/pretooluse-no-node-modules-edit.ts"
import pretoolusNoNpm from "../hooks/pretooluse-no-npm.ts"
import pretoolusNoReadyToBacklog from "../hooks/pretooluse-no-ready-to-backlog.ts"
import pretoolusNoSecrets from "../hooks/pretooluse-no-secrets.ts"
import pretoolusePushCooldown from "../hooks/pretooluse-push-cooldown.ts"
import pretoolusTaskoutputTimeout from "../hooks/pretooluse-taskoutput-timeout.ts"
import { debugLog } from "./debug.ts"
import { detectFrameworks, type Framework } from "./detect-frameworks.ts"
import type { SwizHook } from "./SwizHook.ts"
import type { EffectiveSwizSettings } from "./settings"

export type { SwizHook }

/**
 * File-based hook definition — the original format.
 * The dispatcher spawns `bun hooks/<file>` as a subprocess and communicates
 * via JSON stdin/stdout.
 */
export interface FileHookDef {
  file: string
  timeout?: number
  async?: boolean
  /**
   * Minimum seconds between successive runs of this hook (scoped per hook+cwd).
   *
   * How the timer starts depends on `cooldownMode`:
   * - `"block-only"` (default): timer only starts when the hook **denies or blocks**.
   *   Allow responses do not start the timer, so the hook keeps running until it blocks.
   * - `"always"`: timer starts after **every** run regardless of outcome, so the hook
   *   is skipped for the full cooldown window whether it allowed or denied.
   */
  cooldownSeconds?: number
  /**
   * Controls when the cooldown timer is activated after a hook run.
   *
   * - `"block-only"` (default): cooldown only activates when the hook returns a deny/block.
   *   The hook continues to run on every invocation until it blocks, then cools down.
   * - `"always"`: cooldown activates after every run regardless of result.
   *   Use this for expensive hooks that should run at most once per window.
   *
   * Has no effect when `cooldownSeconds` is not set.
   */
  cooldownMode?: "block-only" | "always"
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
 * Inline hook definition — the new SOLID format.
 * The dispatcher calls `hook.run(input)` directly in-process; no subprocess.
 * All execution metadata (timeout, cooldown, requiredSettings, etc.) is carried
 * by the SwizHook instance itself via SwizHookMeta.
 */
export interface InlineHookDef {
  hook: SwizHook
}

/**
 * A manifest hook entry — either a file-based or inline definition.
 *
 * Discriminate with `isInlineHookDef(def)` or `'hook' in def`.
 * All existing `{ file: "..." }` entries satisfy `FileHookDef` and remain valid.
 */
export type HookDef = FileHookDef | InlineHookDef

/** Type guard: narrows a HookDef to InlineHookDef. */
export function isInlineHookDef(def: HookDef): def is InlineHookDef {
  return "hook" in def
}

/**
 * Returns the canonical identifier for a hook — used for logging, cooldown
 * keying, disabled-hook matching, and README cross-referencing.
 * Always includes the `.ts` extension so identifiers are consistent across
 * file-based and inline formats.
 * - File-based: the `file` field (e.g. `"pretooluse-no-npm.ts"`)
 * - Inline: the `hook.name` field with `.ts` appended (e.g. `"pretooluse-no-npm.ts"`)
 */
export function hookIdentifier(def: HookDef): string {
  if (isInlineHookDef(def)) {
    const name = def.hook.name
    return name.endsWith(".ts") ? name : `${name}.ts`
  }
  return def.file
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
      { file: "stop-incomplete-tasks.ts", timeout: 10 },
      { file: "stop-completion-auditor.ts", timeout: 10 },
      { file: "stop-secret-scanner.ts", timeout: 10 },
      { file: "stop-workflow-permissions.ts", timeout: 10 },
      { file: "stop-large-files.ts", timeout: 10 },
      { file: "stop-suppression-patterns.ts", timeout: 10 },
      { file: "stop-git-status.ts", timeout: 10, requiredSettings: ["gitStatusGate"] },
      { file: "stop-lockfile-drift.ts", timeout: 10 },
      { file: "stop-lint-staged.ts", timeout: 30 },
      { file: "stop-quality-checks.ts", timeout: 60, requiredSettings: ["qualityChecksGate"] },
      { file: "stop-branch-conflicts.ts", timeout: 10 },
      { file: "stop-pr-description.ts", timeout: 10 },
      {
        file: "stop-pr-changes-requested.ts",
        timeout: 10,
        requiredSettings: ["changesRequestedGate"],
      },
      { file: "stop-github-ci.ts", timeout: 45, requiredSettings: ["githubCiGate"] },
      { file: "stop-todo-tracker.ts", timeout: 10 },
      {
        file: "stop-non-default-branch.ts",
        timeout: 10,
        requiredSettings: ["nonDefaultBranchGate"],
      },
      {
        file: "stop-personal-repo-issues.ts",
        timeout: 10,
        cooldownSeconds: 30,
        requiredSettings: ["personalRepoIssuesGate"],
      },
      { file: "stop-upstream-branch-count.ts", timeout: 10, cooldownSeconds: 7200 },
      { file: "stop-memory-size.ts", timeout: 10, cooldownSeconds: 3600 },
      { file: "stop-dependabot-prs.ts", timeout: 10, cooldownSeconds: 3600 },
      { file: "stop-gdpr-data-models.ts", timeout: 10 },
      {
        file: "stop-memory-update-reminder.ts",
        timeout: 10,
        cooldownSeconds: 600,
        requiredSettings: ["memoryUpdateReminder"],
      },
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
    matcher: "TaskCreate|TodoWrite",
    hooks: [{ file: "pretooluse-task-subject-validation.ts", timeout: 5 }],
  },
  {
    event: "preToolUse",
    matcher: "TaskUpdate|update_plan",
    hooks: [
      { file: "pretooluse-taskupdate-schema.ts", timeout: 5 },
      { file: "pretooluse-enforce-taskupdate.ts", timeout: 5 },
      { file: "pretooluse-no-phantom-task-completion.ts", timeout: 5 },
      { file: "pretooluse-dirty-worktree-gate.ts", timeout: 5, cooldownSeconds: 60 },
    ],
  },
  {
    event: "preToolUse",
    matcher: "TaskOutput",
    hooks: [{ hook: pretoolusTaskoutputTimeout }],
  },
  {
    event: "preToolUse",
    matcher: "Edit|Write|NotebookEdit|Bash",
    hooks: [
      { file: "pretooluse-offensive-language.ts", timeout: 5, cooldownSeconds: 60 },
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
      { hook: pretoolusJsonValidation },
      { file: "pretooluse-no-direct-deps.ts", timeout: 5 },
      { hook: pretoolusNoNodeModulesEdit },
      { hook: pretoolusNoLockfileEdit },
      { file: "pretooluse-ts-quality.ts", timeout: 5 },
      { file: "pretooluse-ts-edit-state-gate.ts", timeout: 5 },
      { file: "pretooluse-eslint-config-strength.ts", timeout: 5 },
      { hook: pretoolusNoSecrets },
      { file: "pretooluse-bun-api-enforce.ts", timeout: 5, cooldownSeconds: 30 },
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
      { hook: pretoolusNoMixedToolCalls },
      { file: "pretooluse-enforce-taskupdate.ts", timeout: 5 },
      { file: "pretooluse-banned-commands.ts", timeout: 5 },
      { hook: pretoolusNoMergeConflictComments },
      { hook: pretoolusNoCp },
      { file: "pretooluse-git-index-lock.ts", timeout: 5 },
      { hook: pretoolusNoNpm },
      { hook: pretooluseBunTestConcurrent },
      { file: "pretooluse-protect-sandbox.ts", timeout: 5 },
      { file: "pretooluse-protect-strict-main.ts", timeout: 5 },
      { hook: pretooluseLongSleep },
      { file: "pretooluse-stale-approval-gate.ts", timeout: 10, cooldownSeconds: 300 },
      { file: "pretooluse-push-checks-gate.ts", timeout: 5 },
      { file: "pretooluse-claude-word-limit.ts", timeout: 5 },
      { hook: pretoolusePushCooldown },
      { file: "pretooluse-main-branch-scope-gate.ts", timeout: 10 },
      { file: "pretooluse-block-commit-to-main.ts", timeout: 10 },
      { file: "pretooluse-pr-changes-branch-guard.ts", timeout: 10 },
      { file: "pretooluse-trunk-mode-branch-gate.ts", timeout: 10 },
      { file: "pretooluse-skill-invocation-gate.ts", timeout: 5 },
      { file: "pretooluse-no-push-when-instructed.ts", timeout: 5 },
      { file: "pretooluse-pr-age-gate.ts", timeout: 10 },
      { file: "pretooluse-repeated-lint-test.ts", timeout: 5, cooldownSeconds: 120 },
      { hook: pretoolusNoReadyToBacklog },
      { hook: pretoolusNoIssueClose },
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
      {
        file: "posttooluse-auto-steer.ts",
        timeout: 10,
        async: true,
        requiredSettings: ["autoSteer"],
      },
    ],
  },
  {
    event: "postToolUse",
    matcher: "TaskCreate|TodoWrite",
    hooks: [{ file: "posttooluse-task-subject-validation.ts", timeout: 5 }],
  },
  {
    event: "postToolUse",
    matcher: "TaskList",
    hooks: [{ file: "posttooluse-task-list-sync.ts", timeout: 5 }],
  },
  {
    event: "postToolUse",
    matcher: "TaskUpdate|TaskCreate|TodoWrite",
    hooks: [{ file: "posttooluse-task-audit-sync.ts", timeout: 5 }],
  },
  {
    event: "postToolUse",
    matcher: "TaskOutput",
    hooks: [{ file: "posttooluse-task-output.ts", timeout: 15 }],
  },
  {
    event: "postToolUse",
    matcher: "Skill",
    hooks: [{ file: "posttooluse-skill-steps.ts", timeout: 10 }],
  },
  {
    event: "postToolUse",
    matcher: "Bash",
    hooks: [
      { file: "posttooluse-pr-context.ts", timeout: 10 },
      { file: "posttooluse-pr-create-refine.ts", timeout: 10 },
      { file: "posttooluse-git-context.ts", timeout: 5 },
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
      { hook: precompactSpeak },
      { file: "posttooluse-speak-narrator.ts", timeout: 30, async: true },
    ],
  },
  {
    event: "userPromptSubmit",
    hooks: [
      { file: "userpromptsubmit-git-context.ts", timeout: 5 },
      { file: "userpromptsubmit-task-advisor.ts", timeout: 5 },
      { file: "userpromptsubmit-skill-steps.ts", timeout: 10 },
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

type AgentDef = {
  id: string
  hooksConfigurable: boolean
  eventMap: Record<string, string>
  unsupportedEvents?: string[]
}

function validateAgentEventMaps(agents: AgentDef[], agentEvents: string[]): string[] {
  const errors: string[] = []
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
  return errors
}

export function validateDispatchRoutes(
  dispatchRoutes: Record<string, string>,
  agents: AgentDef[]
): void {
  const manifestEvents = [...new Set(manifest.map((g) => g.event))]
  const agentEvents = [...new Set(manifest.filter((g) => !g.scheduled).map((g) => g.event))]
  const routeEvents = Object.keys(dispatchRoutes)
  const errors: string[] = []

  for (const event of manifestEvents) {
    if (!(event in dispatchRoutes)) {
      errors.push(
        `Manifest event "${event}" has no DISPATCH_ROUTES entry. Add it to DISPATCH_ROUTES in src/commands/dispatch.ts.`
      )
    }
  }

  for (const event of routeEvents) {
    if (!manifest.some((g) => g.event === event)) {
      errors.push(
        `DISPATCH_ROUTES contains "${event}" but no manifest hooks subscribe to it. Remove it from DISPATCH_ROUTES or add hooks in src/manifest.ts.`
      )
    }
  }

  errors.push(...validateAgentEventMaps(agents, agentEvents))

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
