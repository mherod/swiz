import { z } from "zod"

const identity = z.string().trim().min(1).max(200)
export const deadlineTimeFields = {
  dueAt: z.iso
    .datetime({ offset: true })
    .optional()
    .describe("Absolute finish-by time with Z or numeric UTC offset; never a bare local time."),
  durationMinutes: z
    .number()
    .positive()
    .max(525600)
    .optional()
    .describe("Relative duration, resolved once when the request is first accepted."),
  timeZone: z
    .string()
    .max(100)
    .optional()
    .describe("IANA display timezone, default UTC. The dueAt offset determines the instant."),
  reserveMinutes: z
    .number()
    .min(0)
    .max(525600)
    .optional()
    .describe("Minutes reserved for verification and delivery, default 5."),
}

export const deadlineInputFields = {
  action: z.enum(["set", "get", "list", "revise", "attach", "detach", "complete", "cancel"]),
  sessionId: identity.describe(
    "Your actual hook session_id; never a project ID or another agent's session."
  ),
  agentId: identity.optional().describe("Your hook agent_id when running as a subagent."),
  deadlineId: identity.optional(),
  requestId: identity
    .optional()
    .describe("Stable unique key for each mutation. Reuse the same key and arguments on retries."),
  expectedRevision: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Required for revise/complete/cancel; read the current revision first."),
  label: z.string().trim().min(1).max(160).optional(),
  completionCriteria: z.string().trim().min(1).max(1000).optional(),
  parentDeadlineId: identity.optional(),
  reason: z
    .string()
    .trim()
    .min(1)
    .max(1000)
    .optional()
    .describe(
      "Required for revisions, cancellation or completion; completion must cite delivery evidence."
    ),
  ...deadlineTimeFields,
}
export const deadlineInputSchema = z.strictObject(deadlineInputFields)
export type DeadlineInput = z.infer<typeof deadlineInputSchema>

export const taskDeadlineSchema = z.strictObject({
  sessionId: deadlineInputFields.sessionId,
  agentId: deadlineInputFields.agentId,
  requestId: identity,
  expectedRevision: deadlineInputFields.expectedRevision,
  reason: deadlineInputFields.reason,
  parentDeadlineId: deadlineInputFields.parentDeadlineId,
  ...deadlineTimeFields,
})
export type TaskDeadlineInput = z.infer<typeof taskDeadlineSchema>
export interface TaskDeadlineOperation {
  input: TaskDeadlineInput
  task: string | { subject: string; description: string }
}

export interface DeadlineTaskRef {
  storeKey: { kind: "project"; key: string } | { kind: "session"; id: string }
  taskId: string
  tasksDir: string
}

export interface Deadline {
  id: string
  revision: number
  kind: "delivery" | "task"
  label: string
  completionCriteria: string
  dueAt: string
  originalDueAt: string
  timeZone: string
  reserveMinutes: number
  parentDeadlineId?: string
  task?: DeadlineTaskRef
  status: "active" | "completed" | "cancelled"
  createdAt: string
  updatedAt: string
  closedAt?: string
  missedDueAts: string[]
}

export function resolveDeadlineTime(
  input: Pick<DeadlineInput, "dueAt" | "durationMinutes" | "timeZone" | "reserveMinutes">,
  now: number
): { dueAt: string; timeZone: string; reserveMinutes: number } {
  if ((input.dueAt === undefined) === (input.durationMinutes === undefined)) {
    throw new Error("Supply exactly one of dueAt (with an explicit UTC offset) or durationMinutes")
  }
  const timeZone = input.timeZone ?? "UTC"
  // Validate before any state change; invalid zones must never become silent UTC fallbacks.
  new Intl.DateTimeFormat("en-GB", { timeZone }).format(now)
  const dueAt = input.dueAt
    ? new Date(z.iso.datetime({ offset: true }).parse(input.dueAt)).toISOString()
    : new Date(now + input.durationMinutes! * 60_000).toISOString()
  return { dueAt, timeZone, reserveMinutes: input.reserveMinutes ?? 5 }
}

export function deadlinePhase(deadline: Deadline, now: number): string {
  if (deadline.status !== "active") return deadline.status.toUpperCase()
  const remaining = Date.parse(deadline.dueAt) - now
  if (remaining <= 0) return "OVERDUE"
  if (remaining <= 60_000) return "FINAL MINUTE"
  if (remaining <= deadline.reserveMinutes * 60_000) return "DELIVERY RESERVE"
  if (remaining <= 15 * 60_000) return "DUE SOON"
  return "ACTIVE"
}

export function deadlineLocalTime(deadline: Deadline): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: deadline.timeZone,
    dateStyle: "short",
    timeStyle: "long",
  }).format(new Date(deadline.dueAt))
}

function duration(ms: number): string {
  const seconds = Math.ceil(Math.abs(ms) / 1000)
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

export function renderDeadline(deadline: Deadline, now: number): string {
  const remaining = Date.parse(deadline.dueAt) - now
  const timing =
    deadline.status === "active"
      ? `${duration(remaining)} ${remaining <= 0 ? "overdue" : "remaining"}`
      : `closed ${deadline.closedAt}`
  const label = deadline.label.replace(/\s+/g, " ")
  return `${deadline.kind === "task" ? "Task" : "Delivery"} ${deadline.id} r${deadline.revision} — ${label}: ${deadlinePhase(deadline, now)}; ${timing}; due ${deadlineLocalTime(deadline)} [${deadline.timeZone}] (${deadline.dueAt}); reserve ${deadline.reserveMinutes}m${deadline.missedDueAts.length ? `; ${deadline.missedDueAts.length} earlier deadline(s) missed` : ""}.`
}

export function deadlineGuidance(deadline: Deadline, now: number): string {
  const phase = deadlinePhase(deadline, now)
  if (phase === "OVERDUE")
    return "Deadline missed. Report delivered evidence and remaining work; record any extension explicitly."
  if (phase === "FINAL MINUTE" || phase === "DELIVERY RESERVE")
    return "Prioritise verification, integration and delivery. Defer optional work; preserve required checks."
  if (phase === "DUE SOON")
    return "Narrow scope to the required deliverable and prepare the handoff."
  return "Plan within the remaining time, including verification and delivery."
}
