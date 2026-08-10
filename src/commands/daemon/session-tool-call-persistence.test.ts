import { describe, expect, it } from "bun:test"
import {
  type SessionToolCallPersistenceInput,
  SessionToolCallPersistenceQueue,
} from "./session-tool-call-persistence.ts"

function input(sessionId: string, nowMs: number): SessionToolCallPersistenceInput {
  return {
    cwd: "/project",
    sessionId,
    toolName: "Bash",
    toolInput: { command: String(nowMs) },
    nowMs,
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe("SessionToolCallPersistenceQueue", () => {
  it("enqueues without awaiting a blocked filesystem writer", async () => {
    const write = deferred()
    const queue = new SessionToolCallPersistenceQueue(() => write.promise)

    queue.enqueue(input("session-a", 1))

    expect(queue.pendingCount()).toBe(1)
    write.resolve()
    await queue.flush()
    expect(queue.pendingCount()).toBe(0)
  })

  it("preserves per-session order while different sessions drain independently", async () => {
    const firstA = deferred()
    const firstB = deferred()
    const started: string[] = []
    const queue = new SessionToolCallPersistenceQueue(async (entry) => {
      started.push(`${entry.sessionId}:${entry.nowMs}`)
      if (entry.sessionId === "a" && entry.nowMs === 1) await firstA.promise
      if (entry.sessionId === "b" && entry.nowMs === 1) await firstB.promise
    })

    queue.enqueue(input("a", 1))
    queue.enqueue(input("a", 2))
    queue.enqueue(input("b", 1))
    await Bun.sleep(0)

    expect(started).toEqual(["a:1", "b:1"])
    firstA.resolve()
    firstB.resolve()
    await queue.flush()
    expect(started).toEqual(["a:1", "b:1", "a:2"])
  })

  it("continues after a failed write", async () => {
    const written: number[] = []
    const queue = new SessionToolCallPersistenceQueue(async (entry) => {
      if (entry.nowMs === 1) throw new Error("disk unavailable")
      written.push(entry.nowMs)
    })

    queue.enqueue(input("a", 1))
    queue.enqueue(input("a", 2))
    await queue.flush()

    expect(written).toEqual([2])
  })

  it("bounds stalled pending writes and retains the newest entries", async () => {
    const first = deferred()
    const written: number[] = []
    const queue = new SessionToolCallPersistenceQueue(async (entry) => {
      written.push(entry.nowMs)
      if (entry.nowMs === 1) await first.promise
    }, 2)

    queue.enqueue(input("a", 1))
    queue.enqueue(input("a", 2))
    queue.enqueue(input("a", 3))
    queue.enqueue(input("a", 4))
    first.resolve()
    await queue.flush()

    expect(written).toEqual([1, 3, 4])
  })
})
