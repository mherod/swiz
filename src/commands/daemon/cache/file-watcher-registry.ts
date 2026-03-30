import { type FSWatcher, watch } from "node:fs"

export interface WatchEntry {
  path: string
  label: string
  callbacks: Set<() => void>
  watcher: FSWatcher | null
  lastInvalidation: number | null
  invalidationCount: number
}

/**
 * Registry of file-system watchers that trigger cache invalidation callbacks.
 *
 * Used by the daemon to keep caches consistent when hook source files,
 * manifest, settings, or git state change on disk — without requiring a
 * daemon restart. The `hooks/` directory watcher performs a full cache flush
 * on any modification because `HookEligibilityCache` is keyed by `cwd` (not
 * by individual hook file), making per-hook granularity impractical. Since
 * hook edits are infrequent the full-flush approach is cheap and correct.
 */
export class FileWatcherRegistry {
  private entries = new Map<string, WatchEntry>()

  register(path: string, label: string, callback: () => void): void {
    let entry = this.entries.get(path)
    if (!entry) {
      entry = {
        path,
        label,
        callbacks: new Set(),
        watcher: null,
        lastInvalidation: null,
        invalidationCount: 0,
      }
      this.entries.set(path, entry)
    }
    entry.callbacks.add(callback)
  }

  start(): void {
    for (const entry of this.entries.values()) {
      if (entry.watcher) continue
      try {
        entry.watcher = watch(entry.path, { recursive: entry.path.endsWith("/") }, () => {
          entry.lastInvalidation = Date.now()
          entry.invalidationCount += 1
          for (const cb of entry.callbacks) {
            try {
              cb()
            } catch {
              // ignore callback errors
            }
          }
        })
      } catch {
        // path may not exist yet — that's fine
      }
    }
  }

  /** Close and remove all watchers whose label ends with the given suffix. */
  unregisterByLabelSuffix(suffix: string): number {
    let removed = 0
    for (const [path, entry] of this.entries) {
      if (entry.label.endsWith(suffix)) {
        entry.watcher?.close()
        entry.watcher = null
        this.entries.delete(path)
        removed++
      }
    }
    return removed
  }

  close(): void {
    for (const entry of this.entries.values()) {
      entry.watcher?.close()
      entry.watcher = null
    }
  }

  status(): Array<{
    path: string
    label: string
    watching: boolean
    lastInvalidation: number | null
    invalidationCount: number
  }> {
    return [...this.entries.values()].map((e) => ({
      path: e.path,
      label: e.label,
      watching: e.watcher !== null,
      lastInvalidation: e.lastInvalidation,
      invalidationCount: e.invalidationCount,
    }))
  }
}
