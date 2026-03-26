import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AutoSteerStore } from "./auto-steer-store.ts"

describe("AutoSteerStore", () => {
  const tmpDirs: string[] = []

  function createStore(): AutoSteerStore {
    const dir = mkdtempSync(join(tmpdir(), "autosteer-test-"))
    tmpDirs.push(dir)
    return new AutoSteerStore(join(dir, "test.db"))
  }

  afterEach(() => {
    for (const dir of tmpDirs) {
      rmSync(dir, { recursive: true, force: true })
    }
    tmpDirs.length = 0
  })

  it("enqueue and consume single message", () => {
    const store = createStore()
    store.enqueue("sess1", "Fix the tests")
    const results = store.consume("sess1", "next_turn")
    expect(results).toHaveLength(1)
    expect(results[0]!.message).toBe("Fix the tests")
    expect(results[0]!.trigger).toBe("next_turn")
    expect(results[0]!.deliveredAt).toBeNumber()
    store.close()
  })

  it("consumes in FIFO order", () => {
    const store = createStore()
    store.enqueue("sess1", "first")
    store.enqueue("sess1", "second")
    store.enqueue("sess1", "third")
    const results = store.consume("sess1")
    expect(results.map((r) => r.message)).toEqual(["first", "second", "third"])
    store.close()
  })

  it("no message loss when multiple hooks enqueue", () => {
    const store = createStore()
    store.enqueue("sess1", "from require-tasks")
    store.enqueue("sess1", "from task-advisor")
    store.enqueue("sess1", "from test-pairing")
    expect(store.hasPending("sess1")).toBe(true)
    const results = store.consume("sess1")
    expect(results).toHaveLength(3)
    // After consume, no more pending
    expect(store.hasPending("sess1")).toBe(false)
    store.close()
  })

  it("isolates by session_id", () => {
    const store = createStore()
    store.enqueue("sess1", "for sess1")
    store.enqueue("sess2", "for sess2")
    const r1 = store.consume("sess1")
    expect(r1).toHaveLength(1)
    expect(r1[0]!.message).toBe("for sess1")
    const r2 = store.consume("sess2")
    expect(r2).toHaveLength(1)
    expect(r2[0]!.message).toBe("for sess2")
    store.close()
  })

  it("isolates by trigger type", () => {
    const store = createStore()
    store.enqueue("sess1", "next turn msg", "next_turn")
    store.enqueue("sess1", "after commit msg", "after_commit")
    store.enqueue("sess1", "on stop msg", "on_session_stop")
    const nextTurn = store.consume("sess1", "next_turn")
    expect(nextTurn).toHaveLength(1)
    expect(nextTurn[0]!.message).toBe("next turn msg")
    // Others still pending
    expect(store.hasPending("sess1", "after_commit")).toBe(true)
    expect(store.hasPending("sess1", "on_session_stop")).toBe(true)
    store.close()
  })

  it("listPending returns all triggers", () => {
    const store = createStore()
    store.enqueue("sess1", "a", "next_turn")
    store.enqueue("sess1", "b", "after_commit")
    const pending = store.listPending("sess1")
    expect(pending).toHaveLength(2)
    expect(pending.map((p) => p.trigger)).toEqual(["next_turn", "after_commit"])
    store.close()
  })

  it("consume returns empty array when nothing pending", () => {
    const store = createStore()
    const results = store.consume("sess1")
    expect(results).toEqual([])
    store.close()
  })

  it("defaults trigger to next_turn", () => {
    const store = createStore()
    store.enqueue("sess1", "default trigger")
    const results = store.consume("sess1")
    expect(results[0]!.trigger).toBe("next_turn")
    store.close()
  })
})
