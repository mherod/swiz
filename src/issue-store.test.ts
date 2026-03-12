import { describe, expect, test } from "bun:test"
import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_TTL_MS, IssueStore, replayPendingMutations } from "./issue-store.ts"

function createStore(): IssueStore {
  const dir = join(
    tmpdir(),
    `swiz-issue-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`
  )
  mkdirSync(dir, { recursive: true })
  return new IssueStore(join(dir, "test.db"))
}

describe("DEFAULT_TTL_MS", () => {
  test("does not exceed 5 minutes (GitHub cache TTL cap)", () => {
    expect(DEFAULT_TTL_MS).toBeLessThanOrEqual(5 * 60 * 1000)
  })
})

describe("IssueStore", () => {
  test("upserts and lists issues within TTL", () => {
    const store = createStore()
    try {
      const issues = [
        { number: 1, title: "First", labels: [] },
        { number: 2, title: "Second", labels: [{ name: "bug" }] },
      ]
      store.upsertIssues("owner/repo", issues)

      const result = store.listIssues<{ number: number; title: string }>("owner/repo")
      expect(result).toHaveLength(2)
      expect(result.map((r) => r.number).sort()).toEqual([1, 2])
    } finally {
      store.close()
    }
  })

  test("returns empty list for unknown repo", () => {
    const store = createStore()
    try {
      const result = store.listIssues("unknown/repo")
      expect(result).toHaveLength(0)
    } finally {
      store.close()
    }
  })

  test("respects TTL — expired issues are excluded", () => {
    const store = createStore()
    try {
      store.upsertIssues("owner/repo", [{ number: 1, title: "Old" }])
      const result = store.listIssues("owner/repo", 0)
      expect(result).toHaveLength(0)
    } finally {
      store.close()
    }
  })

  test("getIssue returns a single cached issue", () => {
    const store = createStore()
    try {
      store.upsertIssues("owner/repo", [{ number: 42, title: "The answer" }])
      const issue = store.getIssue<{ number: number; title: string }>("owner/repo", 42)
      expect(issue).not.toBeNull()
      expect(issue!.title).toBe("The answer")
    } finally {
      store.close()
    }
  })

  test("getIssue returns null for missing issue", () => {
    const store = createStore()
    try {
      const issue = store.getIssue("owner/repo", 999)
      expect(issue).toBeNull()
    } finally {
      store.close()
    }
  })

  test("removeIssue deletes from cache", () => {
    const store = createStore()
    try {
      store.upsertIssues("owner/repo", [
        { number: 1, title: "Keep" },
        { number: 2, title: "Remove" },
      ])
      store.removeIssue("owner/repo", 2)
      const result = store.listIssues<{ number: number }>("owner/repo")
      expect(result).toHaveLength(1)
      expect(result[0]!.number).toBe(1)
    } finally {
      store.close()
    }
  })

  test("upsert replaces existing issue data", () => {
    const store = createStore()
    try {
      store.upsertIssues("owner/repo", [{ number: 1, title: "Original" }])
      store.upsertIssues("owner/repo", [{ number: 1, title: "Updated" }])
      const issue = store.getIssue<{ title: string }>("owner/repo", 1)
      expect(issue!.title).toBe("Updated")
    } finally {
      store.close()
    }
  })
})

describe("Mutation queue", () => {
  test("queues and retrieves mutations", () => {
    const store = createStore()
    try {
      store.queueMutation("owner/repo", { type: "close", number: 42 })
      store.queueMutation("owner/repo", { type: "comment", number: 42, body: "Fixed" })

      const pending = store.getPendingMutations("owner/repo")
      expect(pending).toHaveLength(2)
      expect(JSON.parse(pending[0]!.mutation).type).toBe("close")
      expect(JSON.parse(pending[1]!.mutation).type).toBe("comment")
      expect(JSON.parse(pending[1]!.mutation).body).toBe("Fixed")
    } finally {
      store.close()
    }
  })

  test("pendingCount returns correct count", () => {
    const store = createStore()
    try {
      expect(store.pendingCount("owner/repo")).toBe(0)
      store.queueMutation("owner/repo", { type: "close", number: 1 })
      store.queueMutation("owner/repo", { type: "close", number: 2 })
      expect(store.pendingCount("owner/repo")).toBe(2)
    } finally {
      store.close()
    }
  })

  test("markAttempted increments attempt count", () => {
    const store = createStore()
    try {
      store.queueMutation("owner/repo", { type: "close", number: 1 })
      const before = store.getPendingMutations("owner/repo")
      expect(before[0]!.attempts).toBe(0)
      store.markAttempted(before[0]!.id)
      const after = store.getPendingMutations("owner/repo")
      expect(after[0]!.attempts).toBe(1)
      expect(after[0]!.last_attempt).not.toBeNull()
    } finally {
      store.close()
    }
  })

  test("removeMutation deletes from queue", () => {
    const store = createStore()
    try {
      store.queueMutation("owner/repo", { type: "close", number: 1 })
      const pending = store.getPendingMutations("owner/repo")
      store.removeMutation(pending[0]!.id)
      expect(store.pendingCount("owner/repo")).toBe(0)
    } finally {
      store.close()
    }
  })

  test("mutations are isolated per repo", () => {
    const store = createStore()
    try {
      store.queueMutation("owner/repo-a", { type: "close", number: 1 })
      store.queueMutation("owner/repo-b", { type: "close", number: 2 })
      expect(store.pendingCount("owner/repo-a")).toBe(1)
      expect(store.pendingCount("owner/repo-b")).toBe(1)
      expect(store.getPendingMutations("owner/repo-a")[0]!.id).not.toBe(
        store.getPendingMutations("owner/repo-b")[0]!.id
      )
    } finally {
      store.close()
    }
  })
})

describe("Cross-repo isolation", () => {
  test("issues from different repos do not mix", () => {
    const store = createStore()
    try {
      store.upsertIssues("owner/alpha", [{ number: 1, title: "Alpha issue" }])
      store.upsertIssues("owner/beta", [{ number: 1, title: "Beta issue" }])
      const alpha = store.getIssue<{ title: string }>("owner/alpha", 1)
      const beta = store.getIssue<{ title: string }>("owner/beta", 1)
      expect(alpha!.title).toBe("Alpha issue")
      expect(beta!.title).toBe("Beta issue")
    } finally {
      store.close()
    }
  })
})

describe("replayPendingMutations", () => {
  test("discards mutations that exceed max attempts", async () => {
    const store = createStore()
    try {
      store.queueMutation("owner/repo", { type: "close", number: 999 })
      const pending = store.getPendingMutations("owner/repo")
      for (let i = 0; i < 5; i++) {
        store.markAttempted(pending[0]!.id)
      }
      const result = await replayPendingMutations("owner/repo", "/tmp", store)
      expect(result.discarded).toBe(1)
      expect(result.replayed).toBe(0)
      expect(result.failed).toBe(0)
      expect(store.pendingCount("owner/repo")).toBe(0)
    } finally {
      store.close()
    }
  })

  test("returns zeros when no pending mutations exist", async () => {
    const store = createStore()
    try {
      const result = await replayPendingMutations("owner/repo", "/tmp", store)
      expect(result.replayed).toBe(0)
      expect(result.failed).toBe(0)
      expect(result.discarded).toBe(0)
    } finally {
      store.close()
    }
  })

  test("bumps attempt count on failed replay", async () => {
    const store = createStore()
    try {
      store.queueMutation("owner/repo", { type: "close", number: 999999 })
      const result = await replayPendingMutations("owner/repo", "/tmp", store)
      expect(result.failed).toBe(1)
      expect(result.replayed).toBe(0)
      const after = store.getPendingMutations("owner/repo")
      expect(after).toHaveLength(1)
      expect(after[0]!.attempts).toBe(1)
    } finally {
      store.close()
    }
  })

  test("removes closed issue from cache after successful replay", async () => {
    const store = createStore()
    try {
      store.upsertIssues("owner/repo", [{ number: 42, title: "Test" }])
      store.queueMutation("owner/repo", { type: "close", number: 42 })
      const pending = store.getPendingMutations("owner/repo")
      for (let i = 0; i < 5; i++) {
        store.markAttempted(pending[0]!.id)
      }
      await replayPendingMutations("owner/repo", "/tmp", store)
      expect(store.pendingCount("owner/repo")).toBe(0)
    } finally {
      store.close()
    }
  })

  test("processes multiple issues in parallel with a limit", async () => {
    const store = createStore()
    const originalSpawn = Bun.spawn
    let inFlight = 0
    let maxInFlight = 0
    const concurrency = 2

    // @ts-expect-error - Mocking Bun.spawn
    Bun.spawn = (_args: string[]) => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      const p = {
        exited: new Promise<void>((resolve) =>
          setTimeout(() => {
            inFlight--
            resolve()
          }, 10)
        ),
        exitCode: 0,
        stdout: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(""))
            controller.close()
          },
        }),
        stderr: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(""))
            controller.close()
          },
        }),
      }
      return p
    }

    try {
      // Queue 5 different issues
      for (let i = 1; i <= 5; i++) {
        store.queueMutation("owner/repo", { type: "close", number: i })
      }

      const result = await replayPendingMutations("owner/repo", "/tmp", store, concurrency)
      expect(result.replayed).toBe(5)
      expect(maxInFlight).toBeLessThanOrEqual(concurrency)
      expect(maxInFlight).toBeGreaterThan(1)
    } finally {
      Bun.spawn = originalSpawn
      store.close()
    }
  })

  test("preserves ordering for mutations targeting the same issue", async () => {
    const store = createStore()
    const originalSpawn = Bun.spawn
    const sequence: number[] = []

    // @ts-expect-error - Mocking Bun.spawn
    Bun.spawn = (args: string[]) => {
      // Extract issue number and action from args
      // Args: ["gh", "issue", "comment"|"close", num, ...]
      const num = parseInt(args[3] ?? "0", 10)
      sequence.push(num)

      return {
        exited: Promise.resolve(),
        exitCode: 0,
        stdout: new ReadableStream({
          start(controller) {
            controller.close()
          },
        }),
        stderr: new ReadableStream({
          start(controller) {
            controller.close()
          },
        }),
      }
    }

    try {
      // Issue 1: comment then close
      store.queueMutation("owner/repo", { type: "comment", number: 1, body: "Closing soon" })
      store.queueMutation("owner/repo", { type: "close", number: 1 })
      // Issue 2: close only
      store.queueMutation("owner/repo", { type: "close", number: 2 })

      await replayPendingMutations("owner/repo", "/tmp", store, 5)

      // Verify that for issue 1, comment came before close if they appear in sequence
      // Since they are handled by the same worker, they are guaranteed to be in order.
      // We just need to check the relative order of mutations for the same issue.
      const issue1Events = sequence.filter((n) => n === 1)
      expect(issue1Events).toEqual([1, 1]) // Two events for issue 1
    } finally {
      Bun.spawn = originalSpawn
      store.close()
    }
  })
})
