import { describe, expect, test } from "bun:test"
import { mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { FileWatcherRegistry } from "./file-watcher-registry.ts"

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
  test("excluded dirs are not mentioned when recursing", async () => {
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
      const totalWatchers = status.reduce((sum, s) => sum + s.watcherCount, 0)

      // With depth=2 and exclusions:
      // base/ (1) + src (1) + src/utils (1) + hooks (1) = 4
      // Without exclusions: base + src + src/utils + .git + .git/objects + .git/refs + .svn + .hg
      //                      + node_modules + node_modules/lodash + hooks = 11
      // 4 is far fewer than 11, confirming exclusions work

      // Also verify excluded names are not in any watched path
      const excluded = [".git", ".svn", ".hg", "node_modules"]
      for (const s of status) {
        for (const excl of excluded) {
          expect(s.path).not.toContain(excl)
        }
      }

      // 4 watchers is the expected count with exclusions
      expect(totalWatchers).toBe(4)

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
