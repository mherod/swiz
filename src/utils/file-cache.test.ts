import { describe, expect, test } from "bun:test"
import { utimesSync } from "node:fs"
import { unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getCachedFileText, getCachedLines, getCachedPrefix } from "./file-cache.ts"

describe("file-cache", () => {
  const content = "line 1\nline 2\nline 3"

  function getTempFile() {
    return join(tmpdir(), `swiz-cache-test-${Math.random().toString(36).slice(2)}.txt`)
  }

  test("reads file text for the first time", async () => {
    const tempFile = getTempFile()
    await Bun.write(tempFile, content)
    try {
      const text = await getCachedFileText(tempFile)
      expect(text).toBe(content)
    } finally {
      await unlink(tempFile).catch(() => {})
    }
  })

  test("reads file from cache if stable (older than 2h)", async () => {
    const tempFile = getTempFile()
    await Bun.write(tempFile, content)
    try {
      // Set mtime to 3 hours ago
      const threeHoursAgo = (Date.now() - 3 * 60 * 60 * 1000) / 1000
      utimesSync(tempFile, threeHoursAgo, threeHoursAgo)

      // First read to populate cache with old mtime
      const firstRead = await getCachedFileText(tempFile)
      expect(firstRead).toBe(content)

      // Modify file on disk WITHOUT changing mtime (simulated)
      await Bun.write(tempFile, "new content")
      utimesSync(tempFile, threeHoursAgo, threeHoursAgo)

      const secondRead = await getCachedFileText(tempFile)
      expect(secondRead).toBe(content) // Should return old content from cache
    } finally {
      await unlink(tempFile).catch(() => {})
    }
  })

  test("re-reads file if it is NOT stable (newer than 2h)", async () => {
    const tempFile = getTempFile()
    try {
      await Bun.write(tempFile, "initial")
      const now = Date.now() / 1000
      utimesSync(tempFile, now, now)

      const first = await getCachedFileText(tempFile)
      expect(first).toBe("initial")

      await Bun.write(tempFile, "updated")
      const second = await getCachedFileText(tempFile)
      expect(second).toBe("updated")
    } finally {
      await unlink(tempFile).catch(() => {})
    }
  })

  test("getCachedLines uses cache", async () => {
    const tempFile = getTempFile()
    try {
      const threeHoursAgo = (Date.now() - 3 * 60 * 60 * 1000) / 1000
      await Bun.write(tempFile, "a\nb\nc")
      utimesSync(tempFile, threeHoursAgo, threeHoursAgo)

      const lines = await getCachedLines(tempFile, 2)
      expect(lines).toEqual(["a", "b"])

      // Change file but keep mtime
      await Bun.write(tempFile, "x\ny\nz")
      utimesSync(tempFile, threeHoursAgo, threeHoursAgo)

      const lines2 = await getCachedLines(tempFile, 2)
      expect(lines2).toEqual(["a", "b"]) // Still old content
    } finally {
      await unlink(tempFile).catch(() => {})
    }
  })

  test("getCachedPrefix uses cache", async () => {
    const tempFile = getTempFile()
    try {
      const threeHoursAgo = (Date.now() - 3 * 60 * 60 * 1000) / 1000
      await Bun.write(tempFile, "prefix-test")
      utimesSync(tempFile, threeHoursAgo, threeHoursAgo)

      const prefix = await getCachedPrefix(tempFile, 3)
      expect(prefix).toBe("pre")

      // Change file but keep mtime
      await Bun.write(tempFile, "changed")
      utimesSync(tempFile, threeHoursAgo, threeHoursAgo)

      const prefix2 = await getCachedPrefix(tempFile, 3)
      expect(prefix2).toBe("pre") // Still old content
    } finally {
      await unlink(tempFile).catch(() => {})
    }
  })
})
