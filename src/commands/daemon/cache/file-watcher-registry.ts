import { type FSWatcher, watch } from "node:fs"

export interface WatchEntry {
  path: string
  label: string
  callbacks: Set<() => void>
  watchers: FSWatcher[]
  lastInvalidation: number | null
  invalidationCount: number
  recursive?: boolean
  depth?: number
}

/**
 * Registry of file-system watchers that trigger cache invalidation callbacks.
 *
 * Used by the daemon to keep caches consistent when hook source files,
 * manifest, settings, or git state change on disk — without requiring a
 * daemon restart.
 *
 * Recursive directory trees use Bun/Node `fs.watch(path, { recursive: true })` so
 * one watcher covers the whole subtree. Pass `depth: 0` to watch only the
 * directory itself (no subtree), e.g. session folders where deep recursion would
 * open too many handles. Changes under ignored path segments (e.g. `node_modules`)
 * are filtered out in the callback.
 */
export class BaseFileWatcherRegistry {
  private entries = new Map<string, WatchEntry>()

  register(
    path: string,
    label: string,
    callback: () => void,
    options?: { recursive?: boolean; depth?: number }
  ): void {
    if (this.shouldIgnore(path)) return

    let entry = this.entries.get(path)
    if (!entry) {
      entry = {
        path,
        label,
        callbacks: new Set(),
        watchers: [],
        lastInvalidation: null,
        invalidationCount: 0,
        recursive: options?.recursive ?? path.endsWith("/"),
        depth: options?.depth,
      }
      this.entries.set(path, entry)
    }
    entry.callbacks.add(callback)
  }

  async start(): Promise<void> {
    for (const entry of this.entries.values()) {
      if (entry.watchers.length > 0) continue

      const fire = () => {
        entry.lastInvalidation = Date.now()
        entry.invalidationCount += 1
        for (const cb of entry.callbacks) {
          try {
            cb()
          } catch {
            // ignore callback errors
          }
        }
      }

      if (entry.recursive && entry.depth !== 0) {
        try {
          const watcher = watch(entry.path, { recursive: true }, (_event, filename) => {
            const rel = filename == null ? "" : `${filename}`
            if (this.shouldIgnoreRelativePath(rel)) return
            fire()
          })
          entry.watchers.push(watcher)
        } catch {
          // path may not exist yet — that's fine
        }
      } else {
        try {
          const watcher = watch(entry.path, { recursive: false }, fire)
          entry.watchers.push(watcher)
        } catch {
          // path may not exist yet — that's fine
        }
      }
    }
  }

  /** True when any path segment is excluded (e.g. node_modules, .git). */
  private shouldIgnoreRelativePath(relativePath: string): boolean {
    if (!relativePath) return false
    for (const part of relativePath.split(/[/\\]+/)) {
      if (!part) continue
      if (this.shouldIgnore(part)) return true
    }
    return false
  }

  private shouldIgnore(name: string): boolean {
    const n = name.toLowerCase()
    return (
      n === ".git" ||
      n === ".svn" ||
      n === ".hg" ||
      n === "node_modules" ||
      n === ".swiz" ||
      n === ".github" ||
      n === ".vscode" ||
      n === ".idea" ||
      n === "dist" ||
      n === "build" ||
      n === "target" ||
      n === "vendor" ||
      name.includes("/.git/") ||
      name.endsWith("/.git")
    )
  }

  /** Close and remove all watchers whose label ends with the given suffix. */
  unregisterByLabelSuffix(suffix: string): number {
    let removed = 0
    for (const [path, entry] of this.entries) {
      if (entry.label.endsWith(suffix)) {
        for (const w of entry.watchers) {
          w.close()
        }
        entry.watchers = []
        this.entries.delete(path)
        removed++
      }
    }
    return removed
  }

  close(): void {
    for (const entry of this.entries.values()) {
      for (const w of entry.watchers) {
        w.close()
      }
      entry.watchers = []
    }
  }

  status(): Array<{
    path: string
    label: string
    watching: boolean
    watcherCount: number
    lastInvalidation: number | null
    invalidationCount: number
  }> {
    return [...this.entries.values()].map((e) => ({
      path: e.path,
      label: e.label,
      watching: e.watchers.length > 0,
      watcherCount: e.watchers.length,
      lastInvalidation: e.lastInvalidation,
      invalidationCount: e.invalidationCount,
    }))
  }
}
