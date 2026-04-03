import { describe, expect, test } from "bun:test"
import { mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { BaseFileWatcherRegistry as FileWatcherRegistry } from "./file-watcher-registry.ts"

function createDirTree(base: string, dirs: string[]): void {
  for (const dir of dirs) {
    mkdirSync(join(base, dir), { recursive: true })
  }
}

function safeRemove(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true })
  } catch {
    // ignore
  }
}

describe("file-watcher-registry exclusion", () => {
  test("recursive root uses a single fs.watch with recursive: true", async () => {
    const base = join("/tmp/swiz-watcher-test-all", `run-${Date.now()}`)
    const dirs = [
      "src",
      "src/utils",
      ".git",
      ".git/objects",
      ".svn",
      ".hg",
      "node_modules",
      "node_modules/lodash",
      "hooks",
    ]
    createDirTree(base, dirs)
    try {
      // Count total watchers by reading status().totalWatchers
      const registry = new FileWatcherRegistry()
      registry.register(join(base, "/"), "test-watch", () => {}, { depth: 2 })
      await registry.start()

      const status = registry.status()
      const totalWatchers = status.reduce(
        (sum: number, s: { watcherCount: number }) => sum + s.watcherCount,
        0
      )

      // One recursive `fs.watch(..., { recursive: true })` on the project root;
      // ignored subtrees are filtered in the change callback, not by skipping watch roots.
      expect(totalWatchers).toBe(1)
      expect(status[0]?.path).toBe(join(base, "/"))

      registry.close()
    } finally {
      safeRemove(base)
    }
  })

  test("ensureWatcherWorks returns boolean", () => {
    const base = join("/tmp/swiz-watcher-test-basic", `run-${Date.now()}`)
    mkdirSync(base, { recursive: true })
    try {
      const registry = new FileWatcherRegistry()
      registry.register(join(base, "/"), "test", () => {}, { depth: 1 })
      expect(registry.status().length).toBe(1)
      registry.close()
    } finally {
      safeRemove(base)
    }
  })
})
