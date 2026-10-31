import { type FSWatcher, watch } from "node:fs"
import { lstat, readdir } from "node:fs/promises"
import { join, sep } from "node:path"

// ─── Skill sync watch loop ───────────────────────────────────────────────────
//
// Keeps a target skill root in sync with its sources while running. A skill is
// synced only once it has been quiet — no watcher event and no file modified on
// either side — for the full quiet window, so an edit in progress is never
// copied half-written. fs.watch can drop events (notably on macOS), so a
// periodic fingerprint sweep and file mtimes back up the event stream.

/** Required stillness before a changed skill is synced. */
export const DEFAULT_SKILL_SYNC_QUIET_MS = 20_000

export interface SkillSyncWatchOptions {
  sourceRoots: string[]
  targetRoot: string
  /** Stillness required before syncing a skill. */
  quietMs: number
  /** Interval for the fingerprint sweep that catches dropped watcher events. */
  sweepMs: number
  signal: AbortSignal
  /** Skill names currently present in the sources. */
  listSkills(): Promise<string[]>
  /** Sync one skill from its highest-precedence source to the target. */
  syncSkill(name: string): Promise<void>
  log(message: string): void
  now?: () => number
}

export interface SkillFingerprint {
  /** Identity of both sides' file trees (paths, sizes, mtimes). */
  key: string
  /** Identity of the source side alone. */
  sourceKey: string
  /** Newest file mtime on either side, in epoch milliseconds. */
  newestMtimeMs: number
}

/** Never part of a skill's content; changes to them must not reset a quiet window. */
const IGNORED_ENTRY_NAMES = new Set([".DS_Store", ".git", "node_modules"])

function isSkillName(name: string | undefined): name is string {
  return Boolean(name) && !name!.startsWith(".") && !IGNORED_ENTRY_NAMES.has(name!)
}

/**
 * Map a changed path to the skill it belongs to. The most specific root wins, so
 * `~/.agents/skills/foo` is skill `foo` even though `~/.agents` is also a root.
 */
export function skillNameForPath(roots: string[], absolutePath: string): string | null {
  if (roots.includes(absolutePath)) return null
  const byDepth = [...roots].sort((a, b) => b.length - a.length)
  for (const root of byDepth) {
    if (!absolutePath.startsWith(root + sep)) continue
    const name = absolutePath.slice(root.length + 1).split(sep)[0]
    return isSkillName(name) ? name : null
  }
  return null
}

async function treeStamp(
  dir: string,
  relativeDir = "",
  stamp = { lines: [] as string[], newest: 0 }
): Promise<{ lines: string[]; newest: number }> {
  let entries: import("node:fs").Dirent[]
  try {
    entries = await readdir(join(dir, relativeDir), { withFileTypes: true })
  } catch {
    return stamp
  }
  for (const entry of entries) {
    if (IGNORED_ENTRY_NAMES.has(entry.name)) continue
    const relativePath = relativeDir ? join(relativeDir, entry.name) : entry.name
    const stats = await lstat(join(dir, relativePath)).catch(() => null)
    if (!stats) continue
    stamp.lines.push(`${relativePath}\t${stats.size}\t${stats.mtimeMs}`)
    stamp.newest = Math.max(stamp.newest, stats.mtimeMs)
    if (entry.isDirectory()) await treeStamp(dir, relativePath, stamp)
  }
  return stamp
}

export async function fingerprintSkill(
  sourceRoots: string[],
  targetRoot: string,
  name: string
): Promise<SkillFingerprint> {
  const sources = await Promise.all(sourceRoots.map((root) => treeStamp(join(root, name))))
  const target = await treeStamp(join(targetRoot, name))
  const sourceText = sources.map((s, i) => `#${i}\n${s.lines.join("\n")}`).join("\n")
  return {
    key: String(Bun.hash(`${sourceText}\n--target--\n${target.lines.join("\n")}`)),
    sourceKey: String(Bun.hash(sourceText)),
    newestMtimeMs: Math.max(target.newest, ...sources.map((s) => s.newest)),
  }
}

class SkillSyncWatcher {
  /** Skills awaiting a quiet window → time of the last observed change. */
  private readonly pending = new Map<string, number>()
  /** Fingerprint of each skill when it was last settled, so unchanged skills are skipped. */
  private readonly settled = new Map<string, string>()
  private readonly watchers: FSWatcher[] = []
  private readonly roots: string[]
  private readonly now: () => number
  private nextSweepAt = 0
  private busy: Promise<void> | null = null

  constructor(private readonly options: SkillSyncWatchOptions) {
    this.roots = [...options.sourceRoots, options.targetRoot]
    this.now = options.now ?? Date.now
  }

  async run(): Promise<void> {
    this.startWatchers()
    const { signal } = this.options
    const tickMs = Math.max(10, Math.min(1000, Math.floor(this.options.quietMs / 4)))
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => this.tick(), tickMs)
      const stop = () => {
        clearInterval(timer)
        resolve()
      }
      if (signal.aborted) stop()
      else signal.addEventListener("abort", stop, { once: true })
      this.tick()
    })
    for (const watcher of this.watchers) watcher.close()
    // A skill swap in progress completes before the watch exits.
    await this.busy
  }

  private startWatchers(): void {
    for (const root of this.roots) {
      try {
        const watcher = watch(root, { recursive: true }, (_event, filename) => {
          this.onChange(root, filename ? String(filename) : null)
        })
        watcher.on("error", () => this.requestSweep())
        this.watchers.push(watcher)
      } catch {
        // Missing root or no recursive watch support: the sweep still covers it.
      }
    }
  }

  private onChange(root: string, filename: string | null): void {
    if (!filename) {
      this.requestSweep()
      return
    }
    const name = skillNameForPath(this.roots, join(root, filename))
    if (name) this.pending.set(name, this.now())
  }

  private requestSweep(): void {
    this.nextSweepAt = 0
  }

  private tick(): void {
    if (this.busy || this.options.signal.aborted) return
    this.busy = this.processDue()
      .catch((error) => this.options.log(`watch error: ${String(error)}`))
      .finally(() => {
        this.busy = null
      })
  }

  private async processDue(): Promise<void> {
    if (this.now() >= this.nextSweepAt) {
      await this.sweep()
      this.nextSweepAt = this.now() + this.options.sweepMs
    }
    for (const name of await this.dueSkills()) {
      if (this.options.signal.aborted) return
      await this.syncWhenStill(name)
    }
  }

  /** Mark skills whose trees changed since they were settled, plus newly seen skills. */
  private async sweep(): Promise<void> {
    for (const name of await this.options.listSkills()) {
      if (!isSkillName(name) || this.pending.has(name)) continue
      const settledKey = this.settled.get(name)
      if (settledKey === undefined) {
        this.pending.set(name, 0)
        continue
      }
      const fingerprint = await this.fingerprint(name)
      if (fingerprint.key !== settledKey) this.pending.set(name, fingerprint.newestMtimeMs)
    }
  }

  private fingerprint(name: string): Promise<SkillFingerprint> {
    return fingerprintSkill(this.options.sourceRoots, this.options.targetRoot, name)
  }

  /** Quiet since the later of the last event and the newest file on either side. */
  private isQuiet(lastChange: number, fingerprint: SkillFingerprint): boolean {
    const quietSince = Math.max(lastChange, fingerprint.newestMtimeMs)
    return this.now() - quietSince >= this.options.quietMs
  }

  private async dueSkills(): Promise<string[]> {
    const due: string[] = []
    for (const [name, lastChange] of [...this.pending]) {
      if (this.now() - lastChange < this.options.quietMs) continue
      const fingerprint = await this.fingerprint(name)
      if (!this.isQuiet(lastChange, fingerprint)) {
        this.pending.set(name, Math.max(lastChange, fingerprint.newestMtimeMs))
      } else if (this.settled.get(name) === fingerprint.key) {
        this.pending.delete(name)
      } else {
        due.push(name)
      }
    }
    return due.sort()
  }

  /** Re-verify stillness immediately before writing; any movement restarts the window. */
  private async syncWhenStill(name: string): Promise<void> {
    const lastChange = this.pending.get(name) ?? 0
    const before = await this.fingerprint(name)
    if (!this.isQuiet(lastChange, before)) {
      this.pending.set(name, Math.max(lastChange, before.newestMtimeMs))
      return
    }
    await this.options.syncSkill(name)
    const after = await this.fingerprint(name)
    this.settled.set(name, after.key)
    if (after.sourceKey !== before.sourceKey) {
      this.pending.set(name, this.now())
      const seconds = this.options.quietMs / 1000
      this.options.log(`${name} changed while syncing; syncing again after ${seconds}s of quiet`)
      return
    }
    // Keep a change that arrived during the sync; otherwise the skill is settled.
    if ((this.pending.get(name) ?? 0) === lastChange) this.pending.delete(name)
  }
}

/** Run until `signal` aborts, syncing each skill after it has been quiet for `quietMs`. */
export async function watchSkillSync(options: SkillSyncWatchOptions): Promise<void> {
  await new SkillSyncWatcher(options).run()
}
