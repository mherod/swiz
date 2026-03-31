import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AutoSteerStore, resetAutoSteerStore } from "../auto-steer-store.ts"

/**
 * Integration tests for auto-steer scheduling in transcript command.
 * Verifies that generated auto-replies are correctly persisted and can be consumed.
 */
describe("Transcript Auto-Steer Integration", () => {
  const tmpDirs: string[] = []

  function createTestStore(): AutoSteerStore {
    const dir = mkdtempSync(join(tmpdir(), "transcript-autosteer-"))
    tmpDirs.push(dir)
    return new AutoSteerStore(join(dir, "auto-steer.db"))
  }

  afterEach(() => {
    resetAutoSteerStore()
    for (const dir of tmpDirs) {
      rmSync(dir, { recursive: true, force: true })
    }
    tmpDirs.length = 0
  })

  it("schedules auto-reply messages with next_turn trigger", () => {
    const store = createTestStore()
    const sessionId = "session-abc123"

    // Simulate transcript command scheduling replies
    const replies = [
      "Run the failing test in isolation first",
      "Then apply the fix and verify it passes",
      "Finally, commit your changes",
    ]

    for (const reply of replies) {
      const success = store.enqueue(sessionId, reply, "next_turn")
      expect(success).toBe(true)
    }

    // Verify messages are pending
    expect(store.hasPending(sessionId, "next_turn")).toBe(true)

    // Verify FIFO consumption
    const consumed = store.consume(sessionId, "next_turn")
    expect(consumed).toHaveLength(3)
    const msg0 = consumed[0]?.message
    const msg1 = consumed[1]?.message
    const msg2 = consumed[2]?.message
    expect(msg0).toBe(replies[0])
    expect(msg1).toBe(replies[1])
    expect(msg2).toBe(replies[2])

    // Verify all are marked delivered
    expect(consumed.every((m) => m.deliveredAt !== null)).toBe(true)

    // Verify no more pending
    expect(store.hasPending(sessionId, "next_turn")).toBe(false)

    store.close()
  })

  it("deduplicates identical messages in batch scheduling", () => {
    const store = createTestStore()
    const sessionId = "session-def456"
    const message = "Continue working on the implementation"

    // Attempt to schedule the same message twice
    const first = store.enqueue(sessionId, message, "next_turn")
    const second = store.enqueue(sessionId, message, "next_turn")

    expect(first).toBe(true)
    expect(second).toBe(false) // Deduplicated

    // Verify only one message exists
    expect(store.hasPending(sessionId, "next_turn")).toBe(true)
    const consumed = store.consumeOne(sessionId)
    expect(consumed).toHaveLength(1)
    expect(consumed[0]?.message).toBe(message)

    store.close()
  })

  it("respects different trigger types", () => {
    const store = createTestStore()
    const sessionId = "session-ghi789"

    // Schedule with different triggers
    store.enqueue(sessionId, "Immediate action", "next_turn")
    store.enqueue(sessionId, "After commit", "after_commit")
    store.enqueue(sessionId, "On stop", "on_session_stop")

    // Verify all are pending
    expect(store.listPending(sessionId)).toHaveLength(3)

    // Consume only next_turn
    const nextTurn = store.consumeOne(sessionId, "next_turn")
    expect(nextTurn).toHaveLength(1)
    expect(nextTurn[0]!.message).toBe("Immediate action")

    // Verify others still pending
    expect(store.listPending(sessionId)).toHaveLength(2)
    expect(store.hasPending(sessionId, "after_commit")).toBe(true)
    expect(store.hasPending(sessionId, "on_session_stop")).toBe(true)

    // Consume remaining (one per trigger in FIFO order)
    const remaining: typeof nextTurn = []
    let next = store.consumeOne(sessionId, "after_commit")
    if (next.length > 0) remaining.push(...next)
    next = store.consumeOne(sessionId, "on_session_stop")
    if (next.length > 0) remaining.push(...next)
    expect(remaining).toHaveLength(2)

    store.close()
  })

  it("handles concurrent scheduling with atomic dequeue", () => {
    const store = createTestStore()
    const sessionId = "session-jkl000"

    // Enqueue batch of messages
    const messages = Array.from({ length: 5 }, (_, i) => `Reply ${i + 1}`)
    for (const msg of messages) {
      store.enqueue(sessionId, msg)
    }

    // Simulate concurrent consumption (multiple PostToolUse cycles)
    const batch1 = store.consumeOne(sessionId) // First cycle: 1 message
    const batch2 = store.consumeOne(sessionId) // Second cycle: 1 message
    const batch3 = store.consumeOne(sessionId) // Third cycle: 1 message

    expect(batch1).toHaveLength(1)
    expect(batch2).toHaveLength(1)
    expect(batch3).toHaveLength(1)

    // Verify no message was consumed twice
    const allConsumed = [batch1[0]!.message, batch2[0]!.message, batch3[0]!.message]
    expect(new Set(allConsumed).size).toBe(3) // All unique

    // Verify order preserved
    expect(batch1[0]!.message).toBe("Reply 1")
    expect(batch2[0]!.message).toBe("Reply 2")
    expect(batch3[0]!.message).toBe("Reply 3")

    store.close()
  })

  it("skips expired messages with TTL", () => {
    const store = createTestStore()
    const sessionId = "session-mno111"

    // Enqueue with short TTL (10ms)
    store.enqueue(sessionId, "Short lived", "next_turn", { ttlMs: 10 })
    store.enqueue(sessionId, "Long lived", "next_turn", { ttlMs: 10000 })

    // Wait for first to expire
    Bun.sleepSync(50)

    // Consume: should skip expired (consumeOne respects TTL)
    const consumed = store.consumeOne(sessionId)
    expect(consumed).toHaveLength(1)
    expect(consumed[0]?.message).toBe("Long lived")

    store.close()
  })

  it("tracks dedup across project sessions", () => {
    const store = createTestStore()
    const message = "Build the feature incrementally"

    // Enqueue in session A
    const resultA = store.enqueue("sess-a", message, "next_turn", { cwd: "/projects/swiz" })
    expect(resultA).toBe(true)

    // Attempt same message in session B (same project)
    // Should deduplicate because project_key is derived from cwd
    const resultB = store.enqueue("sess-b", message, "next_turn", { cwd: "/projects/swiz" })
    expect(resultB).toBe(false) // Deduplicated across sessions on same project

    store.close()
  })
})
