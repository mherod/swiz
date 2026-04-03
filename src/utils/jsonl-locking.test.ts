import { describe, expect, it } from "bun:test"
import { mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { TMP_ROOT } from "../temp-paths.ts"
import { appendJsonlEntry, readJsonlFileUntyped, writeJsonlFile } from "./jsonl.ts"

function makeTestDir(label: string): string {
  return join(
    TMP_ROOT,
    `swiz-jsonl-${label}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  )
}

describe("JSONL locking", () => {
  it("should prevent concurrent write corruption", async () => {
    const testDir = makeTestDir("lock")
    try {
      await mkdir(testDir, { recursive: true })
      const filePath = join(testDir, "concurrent.jsonl")

      await writeJsonlFile(filePath, [])

      const numWorkers = 5
      const iterationsPerWorker = 20
      const totalExpected = numWorkers * iterationsPerWorker

      const workers = Array.from({ length: numWorkers }).map(async (_, workerId) => {
        for (let i = 0; i < iterationsPerWorker; i++) {
          await appendJsonlEntry(filePath, { workerId, iteration: i })
          await Bun.sleep(Math.random() * 50)
        }
      })

      await Promise.all(workers)

      const entries = await readJsonlFileUntyped(filePath)
      expect(entries.length).toBe(totalExpected)

      const counts: Record<number, number> = {}
      for (const entry of entries as any[]) {
        counts[entry.workerId] = (counts[entry.workerId] || 0) + 1
      }

      for (let i = 0; i < numWorkers; i++) {
        expect(counts[i]).toBe(iterationsPerWorker)
      }
    } finally {
      await rm(testDir, { recursive: true, force: true })
    }
  })

  it("should handle lock timeouts gracefully", async () => {
    const testDir = makeTestDir("timeout")
    try {
      await mkdir(testDir, { recursive: true })
      const filePath = join(testDir, "timeout.jsonl")

      const { getLockPathForFile } = await import("./file-lock.ts")
      const lockFile = getLockPathForFile(filePath)
      await Bun.write(lockFile, "999999")

      const writePromise = appendJsonlEntry(filePath, { test: "blocked" })

      await Bun.sleep(1000)
      await rm(lockFile, { force: true })

      await writePromise
      const entries = await readJsonlFileUntyped(filePath)
      expect(entries).toEqual([{ test: "blocked" }])
    } finally {
      await rm(testDir, { recursive: true, force: true })
    }
  })

  it("creates parent directories for atomic append targets", async () => {
    const testDir = makeTestDir("parent-dir")
    try {
      const filePath = join(testDir, "nested", "dir", "entries.jsonl")

      await appendJsonlEntry(filePath, { id: 1 })

      const entries = await readJsonlFileUntyped(filePath)
      expect(entries).toEqual([{ id: 1 }])
    } finally {
      await rm(testDir, { recursive: true, force: true })
    }
  })
})
