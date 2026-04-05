/**
 * Type definitions for stop-git-status validator.
 *
 * Domain concepts:
 * - GitStatus: Current branch state (ahead/behind/diverged)
 * - GitContext: Full git environment context for decision making
 * - GitWorkflowCollectResult: Result union for composition with stop-ship-checklist
 */

export interface GitStatus {
  branch: string
  total: number
  modified: number
  added: number
  deleted: number
  untracked: number
  lines: string[]
  upstream: string | null
  ahead: number
  behind: number
}

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
