import type { ActiveHookDispatch, SessionMessage } from "../../commands/daemon/types.ts"

export type {
  SessionMessage,
  SessionTaskSummary,
  ToolCallSummary,
} from "../../commands/daemon/types.ts"

export interface SessionPreview {
  id: string
  provider?: string
  format?: string
  mtime: number
  startedAt?: number
  lastMessageAt?: number
  dispatches?: number
  activeDispatch?: ActiveHookDispatch
  /** True when a verified agent process is running for this session's provider and project. */
  processAlive?: boolean
}

export interface ProjectSessions {
  cwd: string
  name: string
  lastSeenAt: number
  sessionCount: number
  sessions: SessionPreview[]
  statusLine?: string
}

export interface SessionTask {
  id: string
  subject: string
  status: "pending" | "in_progress" | "completed" | "cancelled"
  statusChangedAt: string | null
  completionTimestamp: string | null
  completionEvidence: string | null
}

export interface ProjectTask extends SessionTask {
  sessionId: string
}

export interface ToolStat {
  name: string
  count: number
}

export interface GroupedSessionMessage {
  message: SessionMessage
  count: number
  originalIndices: number[]
}

export interface ParsedToolCallDetail {
  command: string | null
  description: string | null
  commonFields: Array<{ label: string; value: string }>
  rawJson: string | null
}

export interface ParsedSwizTaskCommand {
  action: string
  taskId: string | null
  status: string | null
  subject: string | null
  evidence: string | null
}

export interface ParsedSkillPayload {
  baseDir: string | null
  body: string
  /** Skill id from a `SKILL CONTENT <name>` header, when that format is used */
  declaredSkill: string | null
}

export interface ParsedSearchToolParams {
  pattern: string | null
  path: string | null
  outputMode: string | null
  options: Array<{ label: string; value: string }>
}

export type ProjectStateLabel = "planning" | "developing" | "reviewing" | "addressing-feedback"

export type StatusChipTone = "neutral" | "info" | "warn" | "error" | "success" | "state"

export interface ParsedStatusToken {
  label: string
  tone: StatusChipTone
}

export interface SessionHealth {
  dispatches?: number
  lastMessageAt?: number
  mtime: number
}
