/**
 * Type definitions for stop-git-status validator.
 *
 * Domain concepts:
 * - GitStatus: Current branch state (ahead/behind/diverged)
 * - GitContext: Full git environment context for decision making
 * - GitWorkflowCollectResult: Result union for composition with stop-ship-checklist
 */

import type { StopAction } from "../../src/stop-actions.ts"
import type { GitStatusV2 } from "../../src/utils/git-utils.ts"
import type { SessionFileOwnershipResult } from "../../src/utils/session-file-ownership.ts"

export type GitStatus = GitStatusV2

export interface GitContext {
  cwd: string
  sessionId: string | undefined
  gitStatus: GitStatus
  summary: string
  /** True only when dirty files still require this session to act. */
  hasUncommitted: boolean
  hasRemote: boolean
  upstream: string
  collabMode: "solo" | "auto" | "team" | "relaxed-collab"
  pushCooldownMinutes: number
  defaultBranch: string
  trunkMode: boolean
  strictNoDirectMain?: boolean
  /** Query certainty and the three dirty-file attribution buckets. */
  ownership: SessionFileOwnershipResult
}

export type ActionPlanItem = string | string[]

export type GitWorkflowCollectResult =
  | { kind: "ok"; context?: string }
  | { kind: "hookOutput"; output: { ok: boolean } | { reason: string } }
  | {
      kind: "block"
      summary: string
      steps: ActionPlanItem[]
      willNeedPush: boolean
      sessionId: string | undefined
      cwd: string
      taskSubject: string
      taskDesc: string
      action?: StopAction
    }
