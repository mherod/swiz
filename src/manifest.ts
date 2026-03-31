// Agent-agnostic hook manifest.
// Single source of truth for all hook scripts and event bindings.
// install.ts uses it to generate agent configs; dispatch.ts uses it at runtime.
// Hooks may set `async: true` for concurrent scheduling; optional `asyncMode` chooses
// fire-and-forget (default) vs block-until-complete (sync pipeline). See SwizHookMeta.

import posttooluseAutoSteer from "../hooks/posttooluse-auto-steer.ts"
import posttoolusGitContext from "../hooks/posttooluse-git-context.ts"
import posttoolusGitStatus from "../hooks/posttooluse-git-status.ts"
import posttooluseGitTaskAutocomplete from "../hooks/posttooluse-git-task-autocomplete.ts"
import posttooluseJsonValidation from "../hooks/posttooluse-json-validation.ts"
import posttooluseMemorySize from "../hooks/posttooluse-memory-size.ts"
import posttoolusPrContext from "../hooks/posttooluse-pr-context.ts"
import posttoolusePrCreateRefine from "../hooks/posttooluse-pr-create-refine.ts"
import posttoolusePrettierTs from "../hooks/posttooluse-prettier-ts.ts"
import posttoolusePostPushCooldown from "../hooks/posttooluse-push-cooldown.ts"
import posttoolusSkillSteps from "../hooks/posttooluse-skill-steps.ts"
import posttooluseSpeakNarrator from "../hooks/posttooluse-speak-narrator.ts"
import posttooluseStateTransition from "../hooks/posttooluse-state-transition.ts"
import posttooluseTaskAdvisor from "../hooks/posttooluse-task-advisor.ts"
import posttooluseTaskAuditSync from "../hooks/posttooluse-task-audit-sync.ts"
import posttooluseTaskListSync from "../hooks/posttooluse-task-list-sync.ts"
import posttooluseTaskOutput from "../hooks/posttooluse-task-output.ts"
import posttooluseTaskSubjectValidation from "../hooks/posttooluse-task-subject-validation.ts"
import posttooluseTestPairing from "../hooks/posttooluse-test-pairing.ts"
import posttoolusUpstreamSyncOnPush from "../hooks/posttooluse-upstream-sync-on-push.ts"
import posttoolusVerifyPush from "../hooks/posttooluse-verify-push.ts"
import precommitStagedValidation from "../hooks/precommit-staged-validation.ts"
import precompactSpeak from "../hooks/precompact-speak.ts"
import precompactTaskSnapshot from "../hooks/precompact-task-snapshot.ts"
import pretooluseBannedCommands from "../hooks/pretooluse-banned-commands.ts"
import pretooluseBlockCommitToMain from "../hooks/pretooluse-block-commit-to-main.ts"
import pretooluseBlockPreexistingDismissals from "../hooks/pretooluse-block-preexisting-dismissals.ts"
import pretooluseBunApiEnforce from "../hooks/pretooluse-bun-api-enforce.ts"
import pretooluseBunTestConcurrent from "../hooks/pretooluse-bun-test-concurrent.ts"
import pretoolusClaudeMdWordLimit from "../hooks/pretooluse-claude-md-word-limit.ts"
import pretooluseClaudeWordLimit from "../hooks/pretooluse-claude-word-limit.ts"
import pretooluseDirtyWorktreeGate from "../hooks/pretooluse-dirty-worktree-gate.ts"
import pretooluseEnforceTaskupdate from "../hooks/pretooluse-enforce-taskupdate.ts"
import pretoolusEslintConfigStrength from "../hooks/pretooluse-eslint-config-strength.ts"
import pretooluseGitIndexLock from "../hooks/pretooluse-git-index-lock.ts"
import pretoolusJsonValidation from "../hooks/pretooluse-json-validation.ts"
import pretooluseLargeFiles from "../hooks/pretooluse-large-files.ts"
import pretooluseLongSleep from "../hooks/pretooluse-long-sleep.ts"
import pretooluseMainBranchScopeGate from "../hooks/pretooluse-main-branch-scope-gate.ts"
import pretoolUseManiOrderValidation from "../hooks/pretooluse-manifest-order-validation.ts"
import pretoolusNoCp from "../hooks/pretooluse-no-cp.ts"
import pretoolUseNoDirectDeps from "../hooks/pretooluse-no-direct-deps.ts"
import pretoolusNoIssueClose from "../hooks/pretooluse-no-issue-close.ts"
import pretoolusNoLockfileEdit from "../hooks/pretooluse-no-lockfile-edit.ts"
import pretoolusNoMergeConflictComments from "../hooks/pretooluse-no-merge-conflict-comments.ts"
import pretoolusNoMixedToolCalls from "../hooks/pretooluse-no-mixed-tool-calls.ts"
import pretoolusNoNodeModulesEdit from "../hooks/pretooluse-no-node-modules-edit.ts"
import pretoolusNoNpm from "../hooks/pretooluse-no-npm.ts"
import pretooluseNoPhantomTaskCompletion from "../hooks/pretooluse-no-phantom-task-completion.ts"
import pretoolusNoPushWhenInstructed from "../hooks/pretooluse-no-push-when-instructed.ts"
import pretoolusNoReadyToBacklog from "../hooks/pretooluse-no-ready-to-backlog.ts"
import pretoolusNoSecrets from "../hooks/pretooluse-no-secrets.ts"
import pretooluseNoTaskDelegation from "../hooks/pretooluse-no-task-delegation.ts"
import pretooluseOffensiveLanguage from "../hooks/pretooluse-offensive-language.ts"
import pretoolusePrAgeGate from "../hooks/pretooluse-pr-age-gate.ts"
import pretoolusePrChangesBranchGuard from "../hooks/pretooluse-pr-changes-branch-guard.ts"
import pretoolUseProtectSandbox from "../hooks/pretooluse-protect-sandbox.ts"
import pretoolusePprotectStrictMain from "../hooks/pretooluse-protect-strict-main.ts"
import pretoolusePushChecksGate from "../hooks/pretooluse-push-checks-gate.ts"
import pretoolusePushCooldown from "../hooks/pretooluse-push-cooldown.ts"
import pretooluseReadGrepStallGuard from "../hooks/pretooluse-read-grep-stall-guard.ts"
import pretooluseRepeatedLintTest from "../hooks/pretooluse-repeated-lint-test.ts"
import pretooluseRequireTasks from "../hooks/pretooluse-require-tasks.ts"
import pretooluseSandboxGuidanceConsolidation from "../hooks/pretooluse-sandbox-guidance-consolidation.ts"
import pretooluseSandboxedEdits from "../hooks/pretooluse-sandboxed-edits.ts"
import pretoolusSkillInvocationGate from "../hooks/pretooluse-skill-invocation-gate.ts"
import pretooluseStaleApprovalGate from "../hooks/pretooluse-stale-approval-gate.ts"
import pretooluseStateGate from "../hooks/pretooluse-state-gate.ts"
import pretoolusTaskSubjectValidation from "../hooks/pretooluse-task-subject-validation.ts"
import pretoolusTaskoutputTimeout from "../hooks/pretooluse-taskoutput-timeout.ts"
import pretoolusTaskupdateSchema from "../hooks/pretooluse-taskupdate-schema.ts"
import pretooluseTodoTracker from "../hooks/pretooluse-todo-tracker.ts"
import pretooluseTrunkModeBranchGate from "../hooks/pretooluse-trunk-mode-branch-gate.ts"
import pretooluseTsEditStateGate from "../hooks/pretooluse-ts-edit-state-gate.ts"
import pretooluseTsQuality from "../hooks/pretooluse-ts-quality.ts"
import pretooluseUpdateMemoryEnforcement from "../hooks/pretooluse-update-memory-enforcement.ts"
import pretoolusWorkflowPermissionsGate from "../hooks/pretooluse-workflow-permissions-gate.ts"
import prpollNotify from "../hooks/prpoll-notify.ts"
import sessionstartCompactContext from "../hooks/sessionstart-compact-context.ts"
import sessionstartHealthSnapshot from "../hooks/sessionstart-health-snapshot.ts"
import sessionstartSelfHeal from "../hooks/sessionstart-self-heal.ts"
import sessionstartStateContext from "../hooks/sessionstart-state-context.ts"
import stopAutoContinue from "../hooks/stop-auto-continue.ts"
import stopBranchConflicts from "../hooks/stop-branch-conflicts.ts"
import stopCompletionAuditor from "../hooks/stop-completion-auditor.ts"
import stopDependabotPrs from "../hooks/stop-dependabot-prs.ts"
import stopGdprDataModels from "../hooks/stop-gdpr-data-models.ts"
import stopIncompleteTasks from "../hooks/stop-incomplete-tasks.ts"
import stopLargeFiles from "../hooks/stop-large-files.ts"
import stopLintStaged from "../hooks/stop-lint-staged.ts"
import stopLockfileDrift from "../hooks/stop-lockfile-drift.ts"
import stopMemorySize from "../hooks/stop-memory-size.ts"
import stopMemoryUpdateReminder from "../hooks/stop-memory-update-reminder.ts"
import stopNonDefaultBranch from "../hooks/stop-non-default-branch.ts"
import stopOffensiveLanguage from "../hooks/stop-offensive-language.ts"
import stopPrChangesRequested from "../hooks/stop-pr-changes-requested.ts"
import stopPrDescription from "../hooks/stop-pr-description.ts"
import stopQualityChecks from "../hooks/stop-quality-checks.ts"
import stopSecretScanner from "../hooks/stop-secret-scanner.ts"
import stopShipChecklist from "../hooks/stop-ship-checklist.ts"
import stopSuppressionPatterns from "../hooks/stop-suppression-patterns.ts"
import stopTodoTracker from "../hooks/stop-todo-tracker.ts"
import stopUpstreamBranchCount from "../hooks/stop-upstream-branch-count.ts"
import stopWorkflowPermissions from "../hooks/stop-workflow-permissions.ts"
import userpromptsubmitGitContext from "../hooks/userpromptsubmit-git-context.ts"
import userpromptsubmitSkillSteps from "../hooks/userpromptsubmit-skill-steps.ts"
import userpromptsubmitTaskAdvisor from "../hooks/userpromptsubmit-task-advisor.ts"
import { debugLog } from "./debug.ts"
import { detectFrameworks, type Framework } from "./detect-frameworks.ts"

// Hook type definitions live in hook-types.ts to break the circular dependency:
// manifest.ts → hook files → git-utils.ts → settings.ts → persistence.ts → manifest.ts
// Re-exported here for backward-compatible access.
export {
  type FileHookDef,
  type HookDef,
  type HookGroup,
  hookIdentifier,
  type InlineHookDef,
  isInlineHookDef,
  type SwizHook,
} from "./hook-types.ts"

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

// Local import for types used in this file (re-exports don't create local bindings).
import type { HookGroup } from "./hook-types.ts"

export const manifest: HookGroup[] = [
  {
    event: "stop",
    hooks: [
      { hook: stopOffensiveLanguage },
      { hook: stopIncompleteTasks },
      { hook: stopCompletionAuditor },
      { hook: stopSecretScanner },
      { hook: stopWorkflowPermissions },
      { hook: stopLargeFiles },
      { hook: stopSuppressionPatterns },
      { hook: stopShipChecklist },
      { hook: stopLockfileDrift },
      { hook: stopLintStaged },
      { hook: stopQualityChecks },
      { hook: stopBranchConflicts },
      { hook: stopPrDescription },
      { hook: stopPrChangesRequested },
      { hook: stopTodoTracker },
      { hook: stopNonDefaultBranch },
      { hook: stopUpstreamBranchCount },
      { hook: stopMemorySize },
      { hook: stopDependabotPrs },
      { hook: stopGdprDataModels },
      { hook: stopMemoryUpdateReminder },
      { hook: stopAutoContinue },
      { hook: posttooluseSpeakNarrator },
    ],
  },
  {
    event: "preToolUse",
    hooks: [{ hook: posttooluseSpeakNarrator }],
  },
  {
    event: "preToolUse",
    matcher: "Task",
    hooks: [{ hook: pretooluseNoTaskDelegation }],
  },
  {
    event: "preToolUse",
    matcher: "TaskCreate|TodoWrite",
    hooks: [{ hook: pretoolusTaskSubjectValidation }],
  },
  {
    event: "preToolUse",
    matcher: "TaskUpdate|update_plan",
    hooks: [
      { hook: pretoolusTaskupdateSchema },
      { hook: pretooluseEnforceTaskupdate },
      { hook: pretooluseNoPhantomTaskCompletion },
      { hook: pretooluseDirtyWorktreeGate },
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
    hooks: [{ hook: pretooluseOffensiveLanguage }, { hook: pretooluseUpdateMemoryEnforcement }],
  },
  {
    event: "preToolUse",
    matcher: "Edit|Write|Bash",
    hooks: [
      { hook: pretooluseRequireTasks },
      { hook: pretooluseStateGate },
      { hook: pretooluseBlockPreexistingDismissals },
    ],
  },
  {
    event: "preToolUse",
    matcher: "Edit|Write|NotebookEdit",
    hooks: [
      { hook: pretooluseSandboxedEdits },
      { hook: pretooluseSandboxGuidanceConsolidation },
      { hook: pretoolusJsonValidation },
      { hook: pretoolUseNoDirectDeps },
      { hook: pretoolusNoNodeModulesEdit },
      { hook: pretoolusNoLockfileEdit },
      { hook: pretooluseTsQuality },
      { hook: pretooluseTsEditStateGate },
      { hook: pretoolusEslintConfigStrength },
      { hook: pretoolusNoSecrets },
      { hook: pretooluseBunApiEnforce },
      { hook: pretooluseTodoTracker },
      { hook: pretooluseLargeFiles },
      { hook: pretoolusWorkflowPermissionsGate },
      { hook: pretoolUseManiOrderValidation },
      { hook: pretoolusClaudeMdWordLimit },
    ],
  },
  {
    event: "preToolUse",
    matcher: "Bash",
    hooks: [
      { hook: pretoolusNoMixedToolCalls },
      { hook: pretooluseEnforceTaskupdate },
      { hook: pretooluseBannedCommands },
      { hook: pretoolusNoMergeConflictComments },
      { hook: pretoolusNoCp },
      { hook: pretooluseGitIndexLock },
      { hook: pretoolusNoNpm },
      { hook: pretooluseBunTestConcurrent },
      { hook: pretoolUseProtectSandbox },
      { hook: pretoolusePprotectStrictMain },
      { hook: pretooluseLongSleep },
      { hook: pretooluseStaleApprovalGate },
      { hook: pretoolusePushChecksGate },
      { hook: pretooluseClaudeWordLimit },
      { hook: pretoolusePushCooldown },
      { hook: pretooluseMainBranchScopeGate },
      { hook: pretooluseBlockCommitToMain },
      { hook: pretoolusePrChangesBranchGuard },
      { hook: pretooluseTrunkModeBranchGate },
      { hook: pretoolusSkillInvocationGate },
      { hook: pretoolusNoPushWhenInstructed },
      { hook: pretoolusePrAgeGate },
      { hook: pretooluseRepeatedLintTest },
      { hook: pretoolusNoReadyToBacklog },
      { hook: pretoolusNoIssueClose },
    ],
  },
  {
    event: "preToolUse",
    matcher: "Read|Grep|Glob",
    hooks: [{ hook: pretooluseReadGrepStallGuard }],
  },
  {
    event: "postToolUse",
    hooks: [
      { hook: posttoolusGitStatus },
      { hook: posttooluseSpeakNarrator },
      { hook: posttooluseAutoSteer },
    ],
  },
  {
    event: "postToolUse",
    matcher: "TaskCreate|TodoWrite",
    hooks: [{ hook: posttooluseTaskSubjectValidation }],
  },
  {
    event: "postToolUse",
    matcher: "TaskList",
    hooks: [{ hook: posttooluseTaskListSync }],
  },
  {
    event: "postToolUse",
    matcher: "TaskUpdate|TaskCreate|TodoWrite",
    hooks: [{ hook: posttooluseTaskAuditSync }],
  },
  {
    event: "postToolUse",
    matcher: "TaskOutput",
    hooks: [{ hook: posttooluseTaskOutput }],
  },
  {
    event: "postToolUse",
    matcher: "Skill",
    hooks: [{ hook: posttoolusSkillSteps }],
  },
  {
    event: "postToolUse",
    matcher: "Bash",
    hooks: [
      { hook: posttoolusPrContext },
      { hook: posttoolusePrCreateRefine },
      { hook: posttoolusGitContext },
      { hook: posttooluseGitTaskAutocomplete },
      { hook: posttoolusePostPushCooldown },
      { hook: posttoolusVerifyPush },
      { hook: posttooluseStateTransition },
      { hook: posttoolusUpstreamSyncOnPush },
    ],
  },
  {
    event: "postToolUse",
    matcher: "Edit|Write",
    hooks: [
      { hook: posttooluseJsonValidation },
      { hook: posttooluseTestPairing },
      { hook: posttooluseTaskAdvisor },
      { hook: posttooluseMemorySize },
      { hook: posttoolusePrettierTs },
    ],
  },
  {
    event: "sessionStart",
    matcher: "startup",
    hooks: [
      { hook: sessionstartSelfHeal },
      { hook: sessionstartHealthSnapshot },
      { hook: sessionstartStateContext },
      { hook: posttooluseSpeakNarrator },
    ],
  },
  {
    event: "sessionStart",
    matcher: "compact",
    hooks: [{ hook: sessionstartCompactContext }],
  },
  {
    event: "preCompact",
    hooks: [
      { hook: precompactTaskSnapshot },
      { hook: precompactSpeak },
      { hook: posttooluseSpeakNarrator },
    ],
  },
  {
    event: "userPromptSubmit",
    hooks: [
      { hook: userpromptsubmitGitContext },
      { hook: userpromptsubmitTaskAdvisor },
      { hook: userpromptsubmitSkillSteps },
      { hook: posttooluseSpeakNarrator },
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
    hooks: [{ hook: prpollNotify }],
  },
  {
    event: "preCommit",
    scheduled: true,
    hooks: [{ hook: precommitStagedValidation }],
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
  stop: 180, // dominated by stop-auto-continue AI call (~120s) + stop-ship-checklist CI polling (~30s)
  preToolUse: 15, // concurrent: budget = slowest hook (~5s) + overhead
  postToolUse: 15, // concurrent: budget = slowest hook (~10s) + overhead
  sessionStart: 20,
  preCompact: 15,
  userPromptSubmit: 15,
  preCommit: 30,
  prPoll: 20,
}
