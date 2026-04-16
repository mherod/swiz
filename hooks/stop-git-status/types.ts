/**
 * Type definitions for stop-git-status validator.
 *
 * Domain concepts:
 * - GitStatus: Current branch state (ahead/behind/diverged)
 * - GitContext: Full git environment context for decision making
 * - GitWorkflowCollectResult: Result union for composition with stop-ship-checklist
 */

import type { GitStatusV2 } from "../../src/utils/git-utils.ts"

export type GitStatus = GitStatusV2

export interface GitContext {
  cwd: string
  sessionId: string | undefined
  gitStatus: GitStatus
  hasUncommitted: boolean
  hasRemote: boolean
  upstream: string
  collabMode: "solo" | "auto" | "team" | "relaxed-collab"
  pushCooldownMinutes: number
  defaultBranch: string
  trunkMode: boolean
}

export type ActionPlanItem = string | string[]

export type GitWorkflowCollectResult =
  | { kind: "ok" }
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
    }
