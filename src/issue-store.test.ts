import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { IssueStore, resetIssueStore } from "./issue-store.ts"

function tempDbPath(): string {
  const dir = join(
    tmpdir(),
    `swiz-issue-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  )
  mkdirSync(dir, { recursive: true })
  return join(dir, "test.db")
}

let stores: IssueStore[] = []

afterEach(() => {
  for (const s of stores) {
    try {
      s.close()
    } catch {
      /* ignore */
    }
  }
  stores = []
  resetIssueStore()
})

function createStore(): IssueStore {
  const store = new IssueStore(tempDbPath())
  stores.push(store)
  return store
}

describe("IssueStore", () => {
  test("upserts and lists issues within TTL", () => {
    const store = createStore()
    const issues = [
      { number: 1, title: "First", labels: [] },
      { number: 2, title: "Second", labels: [{ name: "bug" }] },
    ]
    store.upsertIssues("owner/repo", issues)

    const result = store.listIssues<{ number: number; title: string }>("owner/repo")
    expect(result).toHaveLength(2)
    expect(result.map((r) => r.number).sort()).toEqual([1, 2])
  })

  test("returns empty list for unknown repo", () => {
    const store = createStore()
    const result = store.listIssues("unknown/repo")
    expect(result).toHaveLength(0)
  })

  test("respects TTL — expired issues are excluded", () => {
    const store = createStore()
    store.upsertIssues("owner/repo", [{ number: 1, title: "Old" }])

    // Query with 0ms TTL — everything should be expired
    const result = store.listIssues("owner/repo", 0)
    expect(result).toHaveLength(0)
  })

  test("getIssue returns a single cached issue", () => {
    const store = createStore()
    store.upsertIssues("owner/repo", [{ number: 42, title: "The answer" }])

    const issue = store.getIssue<{ number: number; title: string }>("owner/repo", 42)
    expect(issue).not.toBeNull()
    expect(issue!.title).toBe("The answer")
  })

  test("getIssue returns null for missing issue", () => {
    const store = createStore()
    const issue = store.getIssue("owner/repo", 999)
    expect(issue).toBeNull()
  })

  test("removeIssue deletes from cache", () => {
    const store = createStore()
    store.upsertIssues("owner/repo", [
      { number: 1, title: "Keep" },
      { number: 2, title: "Remove" },
    ])

    store.removeIssue("owner/repo", 2)
    const result = store.listIssues<{ number: number }>("owner/repo")
    expect(result).toHaveLength(1)
    expect(result[0]!.number).toBe(1)
  })

  test("upsert replaces existing issue data", () => {
    const store = createStore()
    store.upsertIssues("owner/repo", [{ number: 1, title: "Original" }])
    store.upsertIssues("owner/repo", [{ number: 1, title: "Updated" }])

    const issue = store.getIssue<{ title: string }>("owner/repo", 1)
    expect(issue!.title).toBe("Updated")
  })
})

describe("Mutation queue", () => {
  test("queues and retrieves mutations", () => {
    const store = createStore()
    store.queueMutation("owner/repo", { type: "close", number: 42 })
    store.queueMutation("owner/repo", { type: "comment", number: 42, body: "Fixed" })

    const pending = store.getPendingMutations("owner/repo")
    expect(pending).toHaveLength(2)
    expect(JSON.parse(pending[0]!.mutation).type).toBe("close")
    expect(JSON.parse(pending[1]!.mutation).type).toBe("comment")
    expect(JSON.parse(pending[1]!.mutation).body).toBe("Fixed")
  })

  test("pendingCount returns correct count", () => {
    const store = createStore()
    expect(store.pendingCount("owner/repo")).toBe(0)

    store.queueMutation("owner/repo", { type: "close", number: 1 })
    store.queueMutation("owner/repo", { type: "close", number: 2 })
    expect(store.pendingCount("owner/repo")).toBe(2)
  })

  test("markAttempted increments attempt count", () => {
    const store = createStore()
    store.queueMutation("owner/repo", { type: "close", number: 1 })

    const before = store.getPendingMutations("owner/repo")
    expect(before[0]!.attempts).toBe(0)

    store.markAttempted(before[0]!.id)
    const after = store.getPendingMutations("owner/repo")
    expect(after[0]!.attempts).toBe(1)
    expect(after[0]!.last_attempt).not.toBeNull()
  })

  test("removeMutation deletes from queue", () => {
    const store = createStore()
    store.queueMutation("owner/repo", { type: "close", number: 1 })

    const pending = store.getPendingMutations("owner/repo")
    store.removeMutation(pending[0]!.id)

    expect(store.pendingCount("owner/repo")).toBe(0)
  })

  test("mutations are isolated per repo", () => {
    const store = createStore()
    store.queueMutation("owner/repo-a", { type: "close", number: 1 })
    store.queueMutation("owner/repo-b", { type: "close", number: 2 })

    expect(store.pendingCount("owner/repo-a")).toBe(1)
    expect(store.pendingCount("owner/repo-b")).toBe(1)
    expect(store.getPendingMutations("owner/repo-a")[0]!.id).not.toBe(
      store.getPendingMutations("owner/repo-b")[0]!.id
    )
  })
})

describe("Cross-repo isolation", () => {
  test("issues from different repos do not mix", () => {
    const store = createStore()
    store.upsertIssues("owner/alpha", [{ number: 1, title: "Alpha issue" }])
    store.upsertIssues("owner/beta", [{ number: 1, title: "Beta issue" }])

    const alpha = store.getIssue<{ title: string }>("owner/alpha", 1)
    const beta = store.getIssue<{ title: string }>("owner/beta", 1)
    expect(alpha!.title).toBe("Alpha issue")
    expect(beta!.title).toBe("Beta issue")
  })
})
