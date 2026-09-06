import { describe, expect, test } from "bun:test"
import { utimesSync } from "node:fs"
import { unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  clearFileCache,
  getCachedFileText,
  getCachedLines,
  getCachedPrefix,
  getFileCacheMemoryStats,
} from "./file-cache.ts"

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

      const firstRead = await getCachedFileText(tempFile)
      expect(firstRead).toBe(content)

      // Untouched file: the entry is served from cache rather than re-read.
      const secondRead = await getCachedFileText(tempFile)
      expect(secondRead).toBe(content)
    } finally {
      await unlink(tempFile).catch(() => {})
    }
  })

  test("re-reads a stable file whose size changed under a preserved mtime", async () => {
    // #814: the entry was keyed on mtime alone, so a replacement that restored the
    // timestamp kept serving the previous bytes indefinitely. Size and inode are now
    // part of the fingerprint.
    const tempFile = getTempFile()
    await Bun.write(tempFile, content)
    try {
      const threeHoursAgo = (Date.now() - 3 * 60 * 60 * 1000) / 1000
      utimesSync(tempFile, threeHoursAgo, threeHoursAgo)
      expect(await getCachedFileText(tempFile)).toBe(content)

      await Bun.write(tempFile, "new content")
      utimesSync(tempFile, threeHoursAgo, threeHoursAgo)

      expect(await getCachedFileText(tempFile)).toBe("new content")
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

      // Untouched file: served from cache.
      expect(await getCachedPrefix(tempFile, 3)).toBe("pre")

      // Changed size under a preserved mtime must still invalidate the prefix.
      await Bun.write(tempFile, "changed")
      utimesSync(tempFile, threeHoursAgo, threeHoursAgo)

      expect(await getCachedPrefix(tempFile, 3)).toBe("cha")
    } finally {
      await unlink(tempFile).catch(() => {})
    }
  })

  test("serves a caller a file above the admission ceiling without retaining it", async () => {
    const tempFile = getTempFile()
    try {
      // 2 MiB is the ceiling; go past it so admission is refused.
      const oversized = "x".repeat(2 * 1024 * 1024 + 1024)
      await Bun.write(tempFile, oversized)
      const threeHoursAgo = (Date.now() - 3 * 60 * 60 * 1000) / 1000
      utimesSync(tempFile, threeHoursAgo, threeHoursAgo)

      clearFileCache()
      expect((await getCachedFileText(tempFile)).length).toBe(oversized.length)
      // The caller got its bytes, but nothing was retained.
      expect(getFileCacheMemoryStats().entries).toBe(0)
    } finally {
      await unlink(tempFile).catch(() => {})
    }
  })

  test("bounds retention to the entry cap under a many-file scan", async () => {
    const created: string[] = []
    try {
      clearFileCache()
      const threeHoursAgo = (Date.now() - 3 * 60 * 60 * 1000) / 1000
      for (let i = 0; i < 300; i++) {
        const path = getTempFile()
        created.push(path)
        await Bun.write(path, `entry-${i}`)
        utimesSync(path, threeHoursAgo, threeHoursAgo)
        await getCachedFileText(path)
      }

      const stats = getFileCacheMemoryStats()
      // 300 distinct stable files, but retention stops at the 256-entry cap.
      expect(stats.entries).toBeLessThanOrEqual(256)
      expect(stats.estimatedBytes).toBeLessThanOrEqual(16 * 1024 * 1024)
    } finally {
      for (const path of created) await unlink(path).catch(() => {})
    }
  })
})
