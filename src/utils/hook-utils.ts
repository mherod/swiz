// Shared utilities for swiz hook scripts.
// Import with: import { denyPreToolUse, allowPreToolUseWithUpdatedInput, isShellTool, isEditTool, ... } from "./hook-utils.ts";
// noinspection JSUnusedGlobalSymbols

import { dirname, join } from "node:path"
import {
  type ActionPlanItem,
  expandSkillReferences,
  formatActionPlan,
  mergeActionPlanIntoTasks,
} from "../action-plan.ts"
import { stderrLog } from "../debug.ts"
import {
  detectForkTopology,
  getOpenPrForBranch,
  getRepoSlug,
  getUpstreamSlug,
  gh,
  ghJsonViaDaemon,
  git,
  hasGhCli,
  isGitHubRemote,
  isGitRepo,
} from "../git-helpers.ts"
import { rephraseHookMessage } from "../hook-message-rephrasing.ts"
import { buildContextHookOutput, type SwizHookOutput } from "../SwizHook.ts"
import { hookSpecificOutputSchema, type SessionHookInput, type ToolHookInput } from "../schemas.ts"
import { skillAdvice, skillExists, skillExistsForHookPayload } from "../skill-utils.ts"
import { getTaskToolName } from "../tasks/task-governance-messages.ts"
import {
  GH_CMD_RE,
  GIT_READ_RE,
  GIT_WRITE_RE,
  READ_CMD_RE,
  RECOVERY_CMD_RE,
  SETUP_CMD_RE,
} from "./git-utils.ts"
import { extractHookSystemMessagePreview } from "./hook-json-helpers.ts"
import {
  hsoPreToolUseAllow,
  hsoPreToolUseAllowContextual,
  hsoPreToolUseDeny,
  hsoPreToolUseDenyTaskFile,
  type TaskFileDenyMeta,
} from "./hook-specific-output.ts"
import { SWIZ_CMD_RE } from "./inline-hook-helpers.ts"

export { preToolUseDeny } from "../SwizHook"
export { getTaskToolName }

// Re-export skillAdvice for backward compatibility with existing hooks.
// New code should import directly from skill-utils.ts.
export { skillAdvice }

export type { SessionHookInput, ToolHookInput }

// ─── Runtime dependency check ───────────────────────────────────────────────
// Verify bun is reachable on PATH. This file executes inside bun, but the
// check catches mangled PATH in non-interactive agent shells where the user's
// profile wasn't sourced. Uses Bun.which() for a fast lookup (no spawn).

if (!Bun.which("bun")) {
  stderrLog(
    "bun PATH check",
    "swiz: bun is not reachable on PATH in this shell environment. " +
      "Hooks that invoke bun scripts will fail. " +
      "Ensure bun is installed: curl -fsSL https://bun.sh/install | bash"
  )
}

// ─── Project convention detection ───────────────────────────────────────────
// Walk up from CWD looking for lockfiles to determine the project's package
// manager and runtime. Cached per process so hooks don't stat the filesystem
// on every import.

export { skillExists, skillExistsForHookPayload }
export {
  detectCurrentAgent,
  detectCurrentAgentFromEnv,
  isCurrentAgent,
  isRunningInAgent,
  toolNameForCurrentAgent,
} from "../agent-paths.ts"

export { getCanonicalPathHash } from "../git-helpers.ts"
export { resolveSafeSessionId, sanitizeSessionId, sessionPrefix } from "../session-id.ts"

export type { PackageManager, Runtime } from "./package-detection.ts"

export {
  detectPackageManager,
  detectPkgRunner,
  detectRuntime,
} from "./package-detection.ts"

// ─── Terminal & shell detection ───────────────────────────────────────────
// Re-exported so hook scripts can detect the hosting terminal and shell
// via the single hook-utils.ts import.

export type {
  EnvironmentInfo,
  ShellInfo,
  ShellType,
  TerminalApp,
  TerminalInfo,
} from "./terminal-detection.ts"
export { detectEnvironment, detectShell, detectTerminal } from "./terminal-detection.ts"

// ─── Framework detection ──────────────────────────────────────────────────
// Re-exported from src/detect-frameworks.ts so hook scripts can access it
// via the single hook-utils.ts import, and so src/manifest.ts can import
// directly from src/ without creating a src→hooks dependency.

export type { Framework, ProjectStack } from "../detect-frameworks.ts"
export {
  clearFrameworkCache,
  detectFrameworks,
  detectProjectStack,
} from "../detect-frameworks.ts"

// ─── Cross-agent tool equivalence ──────────────────────────────────────────
// Each set contains all names an agent might use for the same concept.
// Claude Code | Cursor       | Gemini CLI        | Codex CLI
// Re-exported from src/tool-matchers.ts so hook scripts keep using the
// single hook-utils.ts import, while src/ modules can import directly
// without reaching into hooks/.
export {
  EDIT_TOOLS,
  isCodeChangeTool,
  isEditTool,
  isFileEditTool,
  isNotebookTool,
  isShellTool,
  isSkillTool,
  isTaskCreateTool,
  isTaskGetTool,
  isTaskListTool,
  isTaskTool,
  isTaskUpdateTool,
  isWriteTool,
  NOTEBOOK_TOOLS,
  READ_TOOLS,
  SEARCH_TOOLS,
  SHELL_TOOLS,
  SKILL_TOOLS,
  TASK_CREATE_TOOLS,
  TASK_GET_TOOLS,
  TASK_LIST_TOOLS,
  TASK_TOOLS,
  TASK_UPDATE_TOOLS,
  WRITE_TOOLS,
} from "../tool-matchers.ts"

// ─── Subprocess timeout enforcement ─────────────────────────────────────────
// Hooks that spawn subprocesses (lint, typecheck, prettier, git, gh, etc.)
// must use this utility to prevent hangs. SIGTERM is sent on timeout,
// escalated to SIGKILL after a grace period.

// ─── Projected content computation & file-edit predicate ────────────────────
// Canonical implementations live in edit-projection.ts (extracted to avoid
// circular deps when inline SwizHook files import these via manifest.ts).
// `isFileEditForPath` tests whether a hook input is an Edit/Write targeting a
// path with a given suffix — the shared predicate for file-path guards.
// Re-exported here for backward-compatible access via hook-utils.ts.
export {
  computeProjectedContent,
  isFileEditForPath,
  type ProjectedContentInput,
} from "./edit-projection.ts"

// ─── Hook response helpers ─────────────────────────────────────────────────
// The hook-response / output-helper cluster lives in ./hook-response.ts (issue #677).
// Re-exported here so the ~183 existing importers keep resolving through this barrel.
export {
  allowPreToolUse,
  allowPreToolUseWithContext,
  allowPreToolUseWithUpdatedInput,
  blockStop,
  blockStopHumanRequired,
  blockStopHumanRequiredObj,
  blockStopObj,
  blockStopRaw,
  buildDenyPostToolUseOutput,
  denyPostToolUse,
  denyPreToolUse,
  emitContext,
  exitWithHookObject,
  filePathGuardHook,
} from "./hook-response.ts"
// isSwizCommand, PLACEHOLDER_SUBJECT_RE, isPlaceholderSubject live in inline-hook-helpers.ts
// Re-exported here for backwards compatibility with existing consumers.
export {
  isPlaceholderSubject,
  isSwizCommand,
  PLACEHOLDER_SUBJECT_RE,
} from "./inline-hook-helpers.ts"

export { buildContextHookOutput }

export { SwizHookExit } from "../inline-hook-context.ts"

// ─── Stop hook helpers ────────────────────────────────────────────────────

export { type ActionPlanItem, expandSkillReferences, formatActionPlan, mergeActionPlanIntoTasks }

// ─── Git / CLI helpers ──────────────────────────────────────────────────
// Canonical definitions live in src/git-helpers.ts. Imported here so
// internal callers within hook-utils can reference them, and re-exported
// so all hook scripts can keep importing from "./hook-utils.ts" unchanged.

/**
 * Hooks should prefer daemon-backed gh query caching to reduce API pressure.
 * Falls back to direct gh + local TTL cache when daemon is unavailable.
 */
async function ghJson<T>(args: string[], cwd: string): Promise<T | null> {
  return ghJsonViaDaemon<T>(args, cwd, { ttlMs: 300_000 })
}

export {
  detectForkTopology,
  getOpenPrForBranch,
  getRepoSlug,
  getUpstreamSlug,
  gh,
  ghJson,
  git,
  hasGhCli,
  isGitHubRemote,
  isGitRepo,
}

// ─── Session task I/O ────────────────────────────────────────────────────────

// ─── Subject fingerprinting (re-exported from src/) ─────────────────────
export {
  computeSubjectFingerprint,
  normalizeSubject,
  significantWords,
  stemWord,
  subjectsOverlap,
} from "../subject-fingerprint.ts"

/**
 * Walk upward from `startDir` to the filesystem root looking for `fileName`.
 * Returns true on first match, false when no match exists.
 */
export async function hasFileInTree(startDir: string, fileName: string): Promise<boolean> {
  if (!startDir || !fileName) return false
  let dir = startDir
  while (true) {
    if (await Bun.file(join(dir, fileName)).exists()) return true
    const parent = dirname(dir)
    if (parent === dir) return false
    dir = parent
  }
}

/**
 * Build the standard denial message for the last-task-standing guard.
 * Both pretooluse-enforce-taskupdate and pretooluse-require-task-evidence use this.
 */
/** Fallback suggestions when no open issues are available. */
const FALLBACK_SUGGESTIONS = [
  "Run quality checks and fix any warnings",
  "Verify recent changes work end-to-end",
  "Check for TODOs or FIXMEs in recently edited files",
  "Update documentation to reflect recent changes",
]

async function suggestNextStep(cwd?: string): Promise<string> {
  if (cwd) {
    try {
      const { getIssueStore } = await import("../issue-store.ts")
      const repoSlug = await getRepoSlug(cwd)
      if (repoSlug) {
        const issues = getIssueStore().listIssues<{
          number: number
          title?: string
          state?: string
        }>(repoSlug)
        const open = issues.find((i) => i.state === "open" && i.title)
        if (open) return `Work on issue #${open.number}: "${open.title}"`
      }
    } catch {}
  }
  return FALLBACK_SUGGESTIONS[Math.floor(Math.random() * FALLBACK_SUGGESTIONS.length)]!
}

export async function buildLastTaskStandingDenial(taskId: string, cwd?: string): Promise<string> {
  const taskCreateName = getTaskToolName("TaskCreate")
  const suggestion = await suggestNextStep(cwd)
  return (
    `STOP. Completing task #${taskId} would leave zero incomplete tasks.\n\n` +
    `You have executive authority to determine the next logical step. ` +
    `Before completing this task, plan your next steps:\n\n` +
    formatActionPlan(
      [
        `Use ${taskCreateName} to add at least one pending task for the next logical step (e.g. "${suggestion}").`,
        "Then retry this completion — it will succeed once a pending task exists.",
      ],
      { translateToolNames: true }
    ) +
    `\nThe task list must never be fully complete — there is always a next step to plan.`
  )
}

/** True when a task status counts as terminal work. */
export function isTerminalTaskStatus(status: string): boolean {
  return status === "completed" || status === "cancelled" || status === "deleted"
}

// ─── Command normalisation (re-exported from src/) ──────────────────────
export { normalizeCommand, stripHeredocs } from "../command-utils.ts"
// ─── Task creation (re-exported from src/) ───────────────────────────────
export { type CreateTaskOptions, createTaskInProcess } from "../tasks/task-service.ts"
// ─── Transcript summary (re-exported from src/) ────────────────────────
export {
  type CurrentSessionTaskToolStats,
  computeTranscriptSummary,
  deriveCurrentSessionTaskToolStats,
  findLastTaskToolCallIndex,
  formatCurrentSessionUsageWindow,
  getBashCommandsUsedForCurrentSession,
  getCurrentSessionTaskToolStats,
  getRecentBashCommandsUsedForCurrentSession,
  getRecentSkillsUsedForCurrentSession,
  getRecentToolsUsedForCurrentSession,
  getSkillsUsedForCurrentSession,
  getToolsUsedForCurrentSession,
  getTranscriptSummary,
  parseTranscriptSummary,
  type TranscriptSummary,
} from "../transcript-summary.ts"
// ─── Error helpers (re-exported from src/) ──────────────────────────────
export { messageFromUnknownError } from "./hook-json-helpers.ts"
// Session task creation (sentinel dedup + subprocess fallback) extracted to
// session-task-io.ts in #679; re-exported here so importers are unchanged.
export { createSessionTask } from "./session-task-io.ts"

// ─── Branch, git status, and source file utilities ─────────────────────
// Implementations live in ./utils/git-utils.ts; re-exported here for
// backward-compatible access via the single hook-utils.ts import.

export {
  fetchGitStatusFromDaemon,
  parseDaemonGitStateRecord,
} from "./daemon-git-state.ts"
export type {
  ChangeScopeResult,
  ClassifyChangeScopeOptions,
  GitStatSummary,
  GitStatusCounts,
  GitStatusV2,
} from "./git-utils.ts"
export {
  BRANCH_CHECK_RE,
  buildGitContextLine,
  CI_WAIT_RE,
  classifyChangeScope,
  collectCheckoutNewBranchNames,
  collectPlainCheckoutSwitchTargets,
  extractCheckoutNewBranchName,
  extractMergeBranch,
  extractOwnerFromUrl,
  extractPrNumber,
  FORCE_PUSH_RE,
  GH_CMD_RE,
  GH_PR_CHECKOUT_RE,
  GH_PR_CREATE_RE,
  GH_PR_MERGE_RE,
  GIT_ANY_CMD_RE,
  GIT_CHECKOUT_RE,
  GIT_COMMIT_RE,
  GIT_EMPTY_TREE,
  GIT_MERGE_RE,
  GIT_PUSH_DELETE_RE,
  GIT_PUSH_RE,
  GIT_READ_RE,
  GIT_SWITCH_RE,
  GIT_SYNC_RE,
  GIT_WRITE_RE,
  getCurrentGitHubUser,
  getDefaultBranch,
  getGitAheadBehind,
  getGitStatusV2,
  getRepoNameWithOwner,
  hasGitPushForceFlag,
  isDefaultBranch,
  isGitHubHost,
  PR_CHECK_RE,
  parseGitStatSummary,
  parseGitStatus,
  parseRemoteUrl,
  READ_CMD_RE,
  RECOVERY_CMD_RE,
  type RemoteInfo,
  recentHeadRange,
  resolveCurrentFeatureBranch,
  SETUP_CMD_RE,
  SOURCE_EXT_RE,
  SWIZ_ISSUE_RE,
  TEST_FILE_RE,
} from "./git-utils.ts"
export { getEffectiveSwizSettingsForToolHook } from "./hook-effective-settings.ts"

// ─── Transcript parsing ─────────────────────────────────────────────────
// Implementations live in ./utils/transcript.ts; re-exported here for
// backward-compatible access via the single hook-utils.ts import.

export {
  collectBlockedToolUseIds,
  extractBashCommands,
  extractSkillInvocations,
  extractToolBlocksFromEntry,
  extractToolNamesFromTranscript,
  readAllTranscriptLines,
  readSessionLines,
  stripAnsi,
} from "./transcript.ts"

function isExemptGitCommand(command: string): boolean {
  return GIT_READ_RE.test(command) || GIT_WRITE_RE.test(command)
}

function isExemptUtilityCommand(command: string): boolean {
  return (
    READ_CMD_RE.test(command) ||
    RECOVERY_CMD_RE.test(command) ||
    GH_CMD_RE.test(command) ||
    SWIZ_CMD_RE.test(command) ||
    SETUP_CMD_RE.test(command)
  )
}

/** True when a shell command is exempt from task-tracking enforcement. */
export function isTaskTrackingExemptShellCommand(command: string): boolean {
  return isExemptGitCommand(command) || isExemptUtilityCommand(command)
}

// Re-exported from src/git-helpers.ts
export { type ForkTopology, issueState } from "../git-helpers.ts"
export { isSettingDisableCommand } from "./inline-hook-helpers.ts"

// ─── Fork-aware guidance helpers ───────────────────────────────────────────

/**
 * Build fork-aware git push command guidance.
 * In fork workflows, you push to origin (your fork). The command is the same,
 * but the context message differs.
 */
export function forkPushCmd(
  branch: string,
  fork: import("../git-helpers.ts").ForkTopology | null
): string {
  if (fork) return `git push origin ${branch}  # pushes to your fork (${fork.originSlug})`
  return `git push origin ${branch}`
}

/**
 * Build fork-aware PR creation command.
 * In fork workflows, PRs target the upstream repo.
 */
export function forkPrCreateCmd(
  defaultBranch: string,
  fork: import("../git-helpers.ts").ForkTopology | null
): string {
  if (fork) return `gh pr create --repo ${fork.upstreamSlug} --base ${defaultBranch}`
  return `gh pr create --base ${defaultBranch}`
}

/**
 * Build fork-aware sync guidance (fetch + rebase from upstream).
 * Returns null when not in a fork workflow.
 */
export function forkSyncGuidance(
  defaultBranch: string,
  fork: import("../git-helpers.ts").ForkTopology | null
): string | null {
  if (!fork) return null
  const lines = [
    `Sync your fork with upstream:`,
    `  git fetch upstream`,
    `  git rebase upstream/${defaultBranch}`,
  ]
  if (!fork.hasUpstreamRemote) {
    lines.unshift(`Set up the upstream remote first:`)
    lines.splice(1, 0, `  git remote add upstream https://github.com/${fork.upstreamSlug}.git`)
  }
  return lines.join("\n")
}

/**
 * Build the remote ref prefix for diff ranges.
 * In fork workflows where upstream is configured, use upstream/<branch>
 * for comparing against the canonical repo's default branch.
 */
export function forkRemoteRef(
  branch: string,
  fork: import("../git-helpers.ts").ForkTopology | null
): string {
  if (fork?.hasUpstreamRemote) return `upstream/${branch}`
  return `origin/${branch}`
}

// ─── Common input types ─────────────────────────────────────────────────

// export interface ToolHookInput {
//   cwd?: string
//   session_id?: string
//   tool_name?: string
//   tool_input?: Record<string, any>
//   transcript_path?: string
// }

// export interface SessionHookInput {
//   cwd?: string
//   session_id?: string
//   trigger?: string
//   matcher?: string
//   hook_event_name?: string
// }

// ─── File utilities ───────────────────────────────────────────────────────

export { countFileWords } from "../file-metrics.ts"
export { spawnSpeak } from "../speech.ts"
// ─── Auto-steer scheduling (extracted to auto-steer-helpers.ts) ────────────
export {
  type AutoSteerRequest,
  isAutoSteerAvailable,
  renderAutoSteerMessage,
  renderQueuedAutoSteerRequest,
  type SendAutoSteerOptions,
  scheduleAutoSteer,
  scheduleAutoSteerViaChannel,
  sendAutoSteer,
} from "./auto-steer-helpers.ts"
/**
 * Returns true when a file path should be skipped by source-scanning hooks.
 * Always skips non-source files (unrecognised extension). Pass any additional
 * per-hook exclusion regexes as extra arguments.
 */
// ─── Edit delta resolution ──────────────────────────────────────────────────
// Canonical implementations live in edit-projection.ts.
export {
  type EditDelta,
  isExcludedSourcePath,
  resolveEditDelta,
} from "./edit-projection.ts"

/** ToolHookInput extended with typed task tool_input fields. */
export type TaskToolInput = ToolHookInput & {
  tool_input?: {
    taskId?: string | number
    status?: string
    subject?: string
    description?: string
    activeForm?: string
    metadata?: Record<string, any>
    [key: string]: unknown
  }
}

/** Build a PreToolUse allow response (mirrors `allowPreToolUse`). */
export function preToolUseAllow(reason = ""): SwizHookOutput {
  const rephrasedReason = reason ? rephraseHookMessage(reason) : reason
  const preview = extractHookSystemMessagePreview(rephrasedReason)
  return {
    suppressOutput: true,
    systemMessage: preview,
    hookSpecificOutput: hsoPreToolUseAllow(rephrasedReason),
  }
}

/** Build a task-file-access denial with structured telemetry metadata. */
export function preToolUseDenyTaskFileAccess(
  reason: string,
  meta: TaskFileDenyMeta = {}
): SwizHookOutput {
  const fullReason = `${reason}

You must act on this now. Do not try to stop again without completing the required action.`
  return {
    suppressOutput: true,
    systemMessage: (extractHookSystemMessagePreview(reason) || "Denied without reason").trim(),
    hookSpecificOutput: hsoPreToolUseDenyTaskFile(fullReason, meta),
  }
}

/** Build a PreToolUse deny response with a distinct visible UI preview. */
export function preToolUseDenyWithSystemMessage(
  reason: string,
  systemMessage: string
): SwizHookOutput {
  const fullReason = `${reason}

You must act on this now. Do not try to stop again without completing the required action.`

  return {
    suppressOutput: true,
    systemMessage: systemMessage.trim() || "Denied without reason",
    hookSpecificOutput: hsoPreToolUseDeny(fullReason),
  }
}

/** Build a PreToolUse allow with advisory `additionalContext` (mirrors `allowPreToolUseWithContext`). */
export function preToolUseAllowWithContext(
  reason: string,
  additionalContext: string
): SwizHookOutput {
  const rephrasedReason = reason ? rephraseHookMessage(reason) : ""
  const rephrasedContext = additionalContext ? rephraseHookMessage(additionalContext) : ""
  const effectiveReason = rephrasedReason || rephrasedContext
  return {
    suppressOutput: true,
    ...(rephrasedContext && { systemMessage: rephrasedContext }),
    hookSpecificOutput: hsoPreToolUseAllowContextual(
      effectiveReason || undefined,
      rephrasedContext || undefined
    ),
  }
}

/** Same envelope as `emitContext` in hook-utils, without `process.exit` (safe for inline dispatch). */
export function postToolUseAdditionalContext(context: string): SwizHookOutput {
  const rephrasedContext = rephraseHookMessage(context)
  return {
    systemMessage: rephrasedContext,
    suppressOutput: true,
    hookSpecificOutput: hookSpecificOutputSchema.parse({
      hookEventName: "PostToolUse",
      additionalContext: rephrasedContext,
    }),
  }
}
