import { type FSWatcher, watch } from "node:fs"
import { readdir } from "node:fs/promises"
import { join } from "node:path"

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
 * Now supports a depth limit for recursive watching to avoid massive resource leaks
 * and keep a sensible limit on watched files.
 */
export class FileWatcherRegistry {
  private entries = new Map<string, WatchEntry>()
  private maxTotalWatchers = 1000 // Sensible safeguard

  constructor(options?: { maxTotalWatchers?: number }) {
    if (options?.maxTotalWatchers) {
      this.maxTotalWatchers = options.maxTotalWatchers
    }
  }

  register(
    path: string,
    label: string,
    callback: () => void,
    options?: { recursive?: boolean; depth?: number }
  ): void {
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

      const onEvent = () => {
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

      if (entry.recursive && entry.depth !== undefined) {
        // Limited depth recursion
        await this.watchRecursiveWithDepth(entry.path, entry.depth, entry.watchers, onEvent)
      } else {
        // Standard single watcher (either non-recursive or native recursive)
        try {
          const watcher = watch(entry.path, { recursive: !!entry.recursive }, onEvent)
          entry.watchers.push(watcher)
        } catch {
          // path may not exist yet — that's fine
        }
      }
    }
  }

  private async watchRecursiveWithDepth(
    path: string,
    depth: number,
    watchers: FSWatcher[],
    callback: () => void
  ): Promise<void> {
    if (depth < 0) return

    // Check global limit before adding more
    const currentTotal = [...this.entries.values()].reduce((acc, e) => acc + e.watchers.length, 0)
    if (currentTotal >= this.maxTotalWatchers) return

    try {
      const watcher = watch(path, { recursive: false }, callback)
      watchers.push(watcher)
    } catch {
      return // Skip if path doesn't exist or no permission
    }

    if (depth > 0) {
      try {
        const files = await readdir(path, { withFileTypes: true })
        for (const file of files) {
          if (file.isDirectory()) {
            await this.watchRecursiveWithDepth(join(path, file.name), depth - 1, watchers, callback)
          }
        }
      } catch {
        // Ignore readdir errors
      }
    }
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
