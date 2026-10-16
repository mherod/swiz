import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { useTempDir } from "../utils/test-utils.ts"
import { deadlineInputSchema, deadlinePhase, renderDeadline, resolveDeadlineTime } from "./model.ts"
import { DeadlineStore, deadlineSessionKey } from "./store.ts"

const tmp = useTempDir("swiz-deadline-store-")
const now = Date.parse("2026-10-15T13:00:00Z")
const input = {
  action: "set" as const,
  sessionId: "owner",
  requestId: "release",
  label: "Release",
  completionCriteria: "Live release with verified data",
  durationMinutes: 30,
}

describe("deadline clock", () => {
  test("project dashboard deduplicates attachments and preserves subagent scope", async () => {
    const cwd = await tmp.create()
    const other = await tmp.create()
    const store = (await DeadlineStore.open(join(cwd, "deadlines.db"), true))!
    try {
      const first = store.mutate(input, cwd, now)
      store.mutate(
        {
          action: "attach",
          sessionId: "peer",
          agentId: "child",
          requestId: "share",
          deadlineId: first.id,
        },
        cwd,
        now
      )
      store.mutate({ ...input, requestId: "elsewhere" }, other, now)
      const items = store.listProject(cwd)
      expect(items).toHaveLength(1)
      expect(items[0]?.sessionKeys).toEqual(["owner", "peer#agent:child"])
      expect(store.listProject(other)).toHaveLength(1)
      expect(store.list(deadlineSessionKey(cwd, "unrelated"))).toEqual([])
      expect(store.history(first.id)).toHaveLength(1)
    } finally {
      store.close()
    }
  })

  test("requires a delivery parent before persisting a child or attachment", async () => {
    const cwd = await tmp.create()
    const store = (await DeadlineStore.open(join(cwd, "deadlines.db"), true))!
    try {
      const task = store.mutate(input, cwd, now, "task")
      const child = { ...input, sessionId: "peer", requestId: "child", parentDeadlineId: task.id }
      expect(() => store.mutate(child, cwd, now, "task")).toThrow("delivery deadline")
      expect(store.list(deadlineSessionKey(cwd, "peer"))).toEqual([])
      const parent = store.mutate({ ...input, requestId: "delivery" }, cwd, now)
      const accepted = store.mutate({ ...child, parentDeadlineId: parent.id }, cwd, now, "task")
      expect(accepted.parentDeadlineId).toBe(parent.id)
      expect(store.list(deadlineSessionKey(cwd, "peer"))).toHaveLength(2)
    } finally {
      store.close()
    }
  })

  test("requires an unambiguous instant, including during a DST fold", () => {
    for (const dueAt of ["4:55", "2026-10-15T16:55:00", "2026-02-30T16:55:00Z"]) {
      expect(
        deadlineInputSchema.safeParse({ ...input, durationMinutes: undefined, dueAt }).success
      ).toBe(false)
    }
    const first = resolveDeadlineTime(
      { dueAt: "2026-10-25T01:30:00+01:00", timeZone: "Europe/London" },
      now
    )
    const second = resolveDeadlineTime(
      { dueAt: "2026-10-25T01:30:00+00:00", timeZone: "Europe/London" },
      now
    )
    expect(Date.parse(second.dueAt) - Date.parse(first.dueAt)).toBe(3600000)
    expect(() => resolveDeadlineTime({ dueAt: first.dueAt, durationMinutes: 1 }, now)).toThrow(
      "exactly one"
    )
    expect(() =>
      resolveDeadlineTime({ durationMinutes: 1, timeZone: "Unknown/Zone" }, now)
    ).toThrow()
  })

  test("resolves once, survives restart, and refuses reuse with changed arguments", async () => {
    const cwd = await tmp.create()
    const path = join(cwd, "deadlines.db")
    const store = (await DeadlineStore.open(path, true))!
    const first = store.mutate(input, cwd, now)
    store.close()
    const reopened = (await DeadlineStore.open(path, true))!
    try {
      expect(reopened.mutate(input, cwd, now + 10 * 60000)).toEqual(first)
      expect(() => reopened.mutate({ ...input, durationMinutes: 40 }, cwd, now)).toThrow(
        "different arguments"
      )
      expect(reopened.history(first.id)).toHaveLength(1)
      expect(reopened.list(deadlineSessionKey(cwd, "owner"))).toHaveLength(1)
    } finally {
      reopened.close()
    }
  })

  test("keeps original misses and revision history after an extension", async () => {
    const cwd = await tmp.create()
    const store = (await DeadlineStore.open(join(cwd, "deadlines.db"), true))!
    try {
      const first = store.mutate(input, cwd, now)
      const revised = store.mutate(
        {
          action: "revise",
          deadlineId: first.id,
          sessionId: "owner",
          requestId: "extension",
          expectedRevision: 1,
          reason: "User authorised five additional minutes",
          durationMinutes: 5,
        },
        cwd,
        now + 31 * 60000
      )
      expect(revised.originalDueAt).toBe(first.dueAt)
      expect(revised.missedDueAts).toEqual([first.dueAt])
      expect(revised.revision).toBe(2)
      expect(store.history(first.id)).toHaveLength(2)
      expect(renderDeadline(revised, now + 31 * 60000)).toContain("earlier deadline(s) missed")
      expect(() =>
        store.mutate(
          {
            action: "revise",
            deadlineId: first.id,
            sessionId: "owner",
            requestId: "stale",
            expectedRevision: 1,
            durationMinutes: 10,
            reason: "stale writer",
          },
          cwd,
          now
        )
      ).toThrow("Revision conflict")
    } finally {
      store.close()
    }
  })

  test("requires explicit attachment and isolates worktrees and subagents", async () => {
    const cwd = await tmp.create()
    const other = await tmp.create()
    const store = (await DeadlineStore.open(join(cwd, "deadlines.db"), true))!
    try {
      const first = store.mutate(input, cwd, now)
      expect(store.list(deadlineSessionKey(cwd, "peer"))).toEqual([])
      expect(store.list(deadlineSessionKey(other, "owner"))).toEqual([])
      expect(store.list(deadlineSessionKey(cwd, "owner", "child"))).toEqual([])
      store.mutate(
        { action: "attach", sessionId: "peer", requestId: "share", deadlineId: first.id },
        other,
        now
      )
      expect(store.list(deadlineSessionKey(other, "peer"))[0]?.id).toBe(first.id)
      store.mutate(
        { action: "detach", sessionId: "peer", requestId: "leave", deadlineId: first.id },
        other,
        now
      )
      expect(store.list(deadlineSessionKey(other, "peer"))).toEqual([])
      expect(store.get(first.id).status).toBe("active")
    } finally {
      store.close()
    }
  })

  test("uses deterministic urgency boundaries and closes only on explicit mutation", async () => {
    const cwd = await tmp.create()
    const store = (await DeadlineStore.open(join(cwd, "deadlines.db"), true))!
    try {
      const first = store.mutate(input, cwd, now)
      const due = Date.parse(first.dueAt)
      expect(deadlinePhase(first, due - 900001)).toBe("ACTIVE")
      expect(deadlinePhase(first, due - 900000)).toBe("DUE SOON")
      expect(deadlinePhase(first, due - 300000)).toBe("DELIVERY RESERVE")
      expect(deadlinePhase(first, due - 60000)).toBe("FINAL MINUTE")
      expect(deadlinePhase(first, due)).toBe("OVERDUE")
      expect(store.get(first.id).status).toBe("active")
      const completed = store.mutate(
        {
          action: "complete",
          sessionId: "owner",
          requestId: "done",
          deadlineId: first.id,
          expectedRevision: 1,
          reason: "pr: https://example.test/release",
        },
        cwd,
        due + 1
      )
      expect(completed.status).toBe("completed")
      expect(completed.missedDueAts).toEqual([first.dueAt])
      expect(() =>
        store.mutate(
          {
            action: "revise",
            sessionId: "owner",
            requestId: "reopen",
            deadlineId: first.id,
            expectedRevision: 2,
            durationMinutes: 5,
            reason: "reset",
          },
          cwd,
          due
        )
      ).toThrow("history is closed")
    } finally {
      store.close()
    }
  })

  test("serializes competing processes with exactly one revision winner", async () => {
    const cwd = await tmp.create()
    const path = join(cwd, "deadlines.db")
    const store = (await DeadlineStore.open(path, true))!
    const first = store.mutate(input, cwd, now)
    store.close()
    const source = `import { DeadlineStore } from ${JSON.stringify(join(import.meta.dir, "store.ts"))};
      const store = await DeadlineStore.open(process.argv[1], true);
      try { store.mutate(JSON.parse(process.argv[2]), process.cwd()); process.stdout.write("won"); }
      catch (error) { process.stdout.write(error.message); } finally { store.close(); }`
    const results = await Promise.all(
      ["a", "b"].map(async (requestId) => {
        const proc = Bun.spawn(
          [
            process.execPath,
            "-e",
            source,
            path,
            JSON.stringify({
              action: "revise",
              sessionId: "owner",
              requestId,
              deadlineId: first.id,
              expectedRevision: 1,
              reason: "Concurrent extension",
              durationMinutes: 5,
            }),
          ],
          {
            cwd,
            env: { ...process.env, HOME: cwd, AI_TEST_NO_BACKEND: "1" },
            stdout: "pipe",
            stderr: "pipe",
          }
        )
        const [stdout, stderr] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ])
        await proc.exited
        expect(proc.exitCode).toBe(0)
        expect(stderr).toBe("")
        return stdout
      })
    )
    expect(results.filter((result) => result === "won")).toHaveLength(1)
    expect(results.filter((result) => result.includes("Revision conflict"))).toHaveLength(1)
  })
})
