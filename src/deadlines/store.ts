import { Database } from "bun:sqlite"
import { randomUUID } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { sessionUsageKey } from "../dispatch/session-usage-key.ts"
import { getHomeDir } from "../home.ts"
import { canonicalClaimPath } from "../session-file-claims.ts"
import {
  type Deadline,
  type DeadlineInput,
  type DeadlineTaskRef,
  deadlineInputSchema,
  resolveDeadlineTime,
  type TaskDeadlineOperation,
} from "./model.ts"

export function deadlineStorePath(): string {
  return join(getHomeDir(), ".swiz", "deadlines.db")
}

export function deadlineSessionKey(cwd: string, sessionId: string, agentId?: string): string {
  return JSON.stringify([canonicalClaimPath(cwd), sessionUsageKey(sessionId, agentId)])
}

const schema = `
CREATE TABLE IF NOT EXISTS deadlines (id TEXT PRIMARY KEY, body TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS deadline_bindings (scope TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(scope, id));
CREATE TABLE IF NOT EXISTS deadline_revisions (id TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL, reason TEXT NOT NULL, PRIMARY KEY(id, revision));
CREATE TABLE IF NOT EXISTS deadline_requests (scope TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(scope, request_id));
`

function fingerprint(value: object): string {
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item
  )
}

/** One connection per operation: CLI fallback and daemon share transactional state on disk. */
export class DeadlineStore {
  private constructor(private readonly db: Database) {}

  static async open(path = deadlineStorePath(), create = false): Promise<DeadlineStore | null> {
    if (!create && !(await Bun.file(path).exists())) return null
    if (create) await mkdir(dirname(path), { recursive: true })
    const db = new Database(path, { create, readonly: !create })
    try {
      db.exec("PRAGMA busy_timeout = 1000")
      if (create) {
        db.exec("PRAGMA journal_mode = WAL")
        db.exec(schema)
      }
      return new DeadlineStore(db)
    } catch (error) {
      db.close()
      throw error
    }
  }

  close(): void {
    this.db.close()
  }

  get(id: string): Deadline {
    const row = this.db
      .query<{ body: string }, [string]>("SELECT body FROM deadlines WHERE id = ?")
      .get(id)
    if (!row) throw new Error(`Deadline ${id} not found`)
    return JSON.parse(row.body) as Deadline
  }

  list(scope: string): Deadline[] {
    return this.db
      .query<{ body: string }, [string]>(
        "SELECT d.body FROM deadlines d JOIN deadline_bindings b ON b.id = d.id WHERE b.scope = ?"
      )
      .all(scope)
      .map((row) => JSON.parse(row.body) as Deadline)
      .sort((a, b) => a.dueAt.localeCompare(b.dueAt) || a.id.localeCompare(b.id))
  }

  history(id: string): Array<{ deadline: Deadline; reason: string }> {
    return this.db
      .query<{ body: string; reason: string }, [string]>(
        "SELECT body, reason FROM deadline_revisions WHERE id = ? ORDER BY revision DESC LIMIT 50"
      )
      .all(id)
      .map((row) => ({ deadline: JSON.parse(row.body) as Deadline, reason: row.reason }))
  }

  /** Dashboard projection: bindings are observed, never attached or changed by a read. */
  listProject(cwd: string): Array<Deadline & { sessionKeys: string[] }> {
    const rows = this.db
      .query<{ body: string; scope: string }, [string]>(
        "SELECT d.body, b.scope FROM deadlines d JOIN deadline_bindings b ON b.id = d.id WHERE json_extract(b.scope, '$[0]') = ? ORDER BY d.id, b.scope"
      )
      .all(canonicalClaimPath(cwd))
    const items = new Map<string, Deadline & { sessionKeys: string[] }>()
    for (const row of rows) {
      const deadline = JSON.parse(row.body) as Deadline
      const item = items.get(deadline.id) ?? { ...deadline, sessionKeys: [] }
      item.sessionKeys.push((JSON.parse(row.scope) as [string, string])[1])
      items.set(deadline.id, item)
    }
    return [...items.values()].sort(
      (a, b) =>
        Number(b.status === "active") - Number(a.status === "active") ||
        a.dueAt.localeCompare(b.dueAt) ||
        a.id.localeCompare(b.id)
    )
  }

  private save(deadline: Deadline, reason: string): Deadline {
    const body = JSON.stringify(deadline)
    this.db
      .query(
        "INSERT INTO deadlines(id, body) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET body=excluded.body"
      )
      .run(deadline.id, body)
    this.db
      .query("INSERT INTO deadline_revisions(id, revision, body, reason) VALUES (?, ?, ?, ?)")
      .run(deadline.id, deadline.revision, body, reason)
    return deadline
  }

  private bind(scope: string, id: string): void {
    this.db.query("INSERT OR IGNORE INTO deadline_bindings(scope, id) VALUES (?, ?)").run(scope, id)
  }

  /** Compare-and-swap and retry receipt commit in the same SQLite transaction. */
  mutate(
    input: DeadlineInput,
    cwd: string,
    now = Date.now(),
    kind: Deadline["kind"] = "delivery",
    options: { operation?: TaskDeadlineOperation; beforeMutation?: () => void } = {}
  ): Deadline {
    return this.mutateScoped(input, cwd, now, kind, options)
  }

  /** Human dashboard operations use project membership, never an agent's session identity. */
  mutateProject(
    input: Omit<DeadlineInput, "sessionId" | "agentId" | "parentDeadlineId">,
    cwd: string,
    now = Date.now()
  ): Deadline {
    if (!["set", "revise", "complete", "cancel"].includes(input.action))
      throw new Error("Unsupported project deadline action")
    if ("sessionId" in input || "agentId" in input || "parentDeadlineId" in input)
      throw new Error("Project deadline actions cannot select a session or parent")
    return this.mutateScoped({ ...input, sessionId: "project:swizbuzz" }, cwd, now, "delivery", {
      projectScope: true,
    })
  }

  private mutateScoped(
    input: DeadlineInput,
    cwd: string,
    now: number,
    kind: Deadline["kind"],
    options: {
      operation?: TaskDeadlineOperation
      beforeMutation?: () => void
      projectScope?: boolean
    }
  ): Deadline {
    input = deadlineInputSchema.parse(input)
    const scope = deadlineSessionKey(cwd, input.sessionId, input.agentId)
    if (!input.requestId)
      throw new Error("requestId is required for mutations; reuse it on retries")
    const key = fingerprint({ input: options.operation ?? input, kind })
    return this.db
      .transaction(() => {
        if (
          options.projectScope &&
          input.deadlineId &&
          !this.listProject(cwd).some((item) => item.id === input.deadlineId)
        )
          throw new Error("Deadline does not belong to this project")
        const previous = this.db
          .query<{ fingerprint: string; id: string }, [string, string]>(
            "SELECT fingerprint, id FROM deadline_requests WHERE scope = ? AND request_id = ?"
          )
          .get(scope, input.requestId!)
        if (previous) {
          if (previous.fingerprint !== key)
            throw new Error("requestId was already used with different arguments")
          return this.get(previous.id)
        }
        validateActionFields(input)
        // Validate dependent writes only for new requests; retries recover their receipt first.
        options.beforeMutation?.()
        const deadline =
          input.action === "set"
            ? this.create(input, scope, now, kind)
            : this.change(input, scope, now, options.projectScope)
        this.db
          .query(
            "INSERT INTO deadline_requests(scope, request_id, fingerprint, id) VALUES (?, ?, ?, ?)"
          )
          .run(scope, input.requestId!, key, deadline.id)
        return deadline
      })
      .immediate()
  }

  private create(
    input: DeadlineInput,
    scope: string,
    now: number,
    kind: Deadline["kind"]
  ): Deadline {
    if (!input.label || !input.completionCriteria)
      throw new Error("set requires label and completionCriteria")
    if (input.deadlineId || input.expectedRevision)
      throw new Error(
        "Use revise with deadlineId and expectedRevision to change an existing deadline"
      )
    const timing = resolveDeadlineTime(input, now)
    if (input.parentDeadlineId && this.get(input.parentDeadlineId).kind !== "delivery")
      throw new Error("parentDeadlineId must reference a delivery deadline")
    const at = new Date(now).toISOString()
    const deadline: Deadline = {
      id: randomUUID(),
      revision: 1,
      kind,
      label: input.label,
      completionCriteria: input.completionCriteria,
      ...timing,
      originalDueAt: timing.dueAt,
      parentDeadlineId: input.parentDeadlineId,
      status: "active",
      createdAt: at,
      updatedAt: at,
      missedDueAts: [],
    }
    this.save(deadline, input.reason ?? "Deadline set")
    this.bind(scope, deadline.id)
    // A child explicitly names its delivery goal. Bind that goal to this caller only.
    if (input.parentDeadlineId) this.bind(scope, input.parentDeadlineId)
    return deadline
  }

  private change(input: DeadlineInput, scope: string, now: number, projectScope = false): Deadline {
    if (!input.deadlineId) throw new Error(`${input.action} requires deadlineId`)
    const current = this.get(input.deadlineId)
    if (input.action === "attach") {
      this.bind(scope, current.id)
      return current
    }
    if (input.action === "detach") {
      this.db
        .query("DELETE FROM deadline_bindings WHERE scope = ? AND id = ?")
        .run(scope, current.id)
      return current
    }
    if (!["revise", "complete", "cancel"].includes(input.action))
      throw new Error("Unsupported deadline mutation")
    if (!projectScope && !this.list(scope).some((item) => item.id === current.id))
      throw new Error("Attach this deadline to your session before changing it")
    validateRevision(current, input)
    return this.reviseCurrent(current, input, now)
  }

  private reviseCurrent(current: Deadline, input: DeadlineInput, now: number): Deadline {
    const next: Deadline = {
      ...current,
      revision: current.revision + 1,
      updatedAt: new Date(now).toISOString(),
      missedDueAts: recordedMisses(current, now),
    }
    if (input.action === "revise") {
      Object.assign(
        next,
        resolveDeadlineTime(
          {
            ...input,
            timeZone: input.timeZone ?? current.timeZone,
            reserveMinutes: input.reserveMinutes ?? current.reserveMinutes,
          },
          now
        )
      )
    } else {
      next.status = input.action === "complete" ? "completed" : "cancelled"
      next.closedAt = next.updatedAt
    }
    return this.save(next, input.reason!)
  }

  /** Retrying a partially persisted TaskCreate binds the same task; never retarget an existing deadline. */
  bindTask(id: string, task: DeadlineTaskRef): void {
    this.db
      .transaction(() => {
        const deadline = this.get(id)
        if (deadline.kind !== "task") throw new Error("Only task deadlines can be bound to tasks")
        if (deadline.task && fingerprint(deadline.task) !== fingerprint(task))
          throw new Error("Deadline already belongs to another task")
        deadline.task = task
        this.db
          .query("UPDATE deadlines SET body = ? WHERE id = ?")
          .run(JSON.stringify(deadline), id)
      })
      .immediate()
  }

  /** Explicit task completion closes only its own clock, using the persisted completion instant. */
  finishTask(id: string, status: "completed" | "cancelled", at: string, evidence: string): void {
    this.db
      .transaction(() => {
        const current = this.get(id)
        if (current.kind !== "task" || current.status !== "active") return
        this.save(
          {
            ...current,
            status,
            revision: current.revision + 1,
            updatedAt: at,
            closedAt: at,
            missedDueAts: recordedMisses(current, Date.parse(at)),
          },
          `Task ${status}: ${evidence}`
        )
      })
      .immediate()
  }
}

function recordedMisses(current: Deadline, now: number): string[] {
  const missed = [...current.missedDueAts]
  if (now > Date.parse(current.dueAt) && !missed.includes(current.dueAt)) missed.push(current.dueAt)
  return missed
}

function validateRevision(current: Deadline, input: DeadlineInput): void {
  if (input.expectedRevision !== current.revision)
    throw new Error(`Revision conflict: expectedRevision must be ${current.revision}`)
  if (!input.reason)
    throw new Error(`${input.action} requires reason (delivery evidence for complete)`)
  if (current.status !== "active")
    throw new Error(`Deadline is already ${current.status}; its history is closed`)
}

function validateActionFields(input: DeadlineInput): void {
  const common = ["action", "sessionId", "agentId", "requestId", "deadlineId"]
  const allowed: Record<DeadlineInput["action"], string[]> = {
    set: [
      ...common,
      "label",
      "completionCriteria",
      "parentDeadlineId",
      "dueAt",
      "durationMinutes",
      "timeZone",
      "reserveMinutes",
      "reason",
    ],
    revise: [
      ...common,
      "expectedRevision",
      "reason",
      "dueAt",
      "durationMinutes",
      "timeZone",
      "reserveMinutes",
    ],
    complete: [...common, "expectedRevision", "reason"],
    cancel: [...common, "expectedRevision", "reason"],
    attach: common,
    detach: common,
    get: common,
    list: common,
  }
  const unexpected = Object.keys(input).filter(
    (key) => input[key as keyof DeadlineInput] !== undefined && !allowed[input.action].includes(key)
  )
  if (unexpected.length) throw new Error(`${input.action} does not accept ${unexpected.join(", ")}`)
}
