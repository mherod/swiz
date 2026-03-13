import { dirname, join } from "node:path"
import { ghJson } from "../../git-helpers.ts"

const CI_WATCH_POLL_MS = 30_000
const CI_WATCH_TIMEOUT_MS = 60 * 60 * 1000

export interface CiWatchRun {
  databaseId: number
  status?: string | null
  conclusion?: string | null
  url?: string | null
}

export interface CiWatchStatus {
  sha: string
  cwd: string
  startedAt: number
  lastCheckedAt: number | null
  runId: number | null
  runUrl: string | null
}

type CiRunFetcher = (cwd: string, sha: string) => Promise<CiWatchRun | null>
type CiNotify = (watch: CiWatchStatus & { conclusion: string }) => Promise<void>

interface CiWatchInternal extends CiWatchStatus {
  deadlineAt: number
  timer: ReturnType<typeof setTimeout> | null
}

function ciWatchKey(cwd: string, sha: string): string {
  return `${cwd}\x00${sha}`
}

async function resolveNotifyBinary(): Promise<string | null> {
  const envBin = process.env.SWIZ_NOTIFY_BIN
  if (envBin?.trim()) return envBin
  const repoRoot = dirname(Bun.main)
  const devPath = join(repoRoot, "macos", "SwizNotify.app", "Contents", "MacOS", "swiz-notify")
  if (await Bun.file(devPath).exists()) return devPath
  const installed = "/usr/local/bin/swiz-notify"
  if (await Bun.file(installed).exists()) return installed
  return null
}

async function defaultCiCompletionNotify(
  watch: CiWatchStatus & { conclusion: string }
): Promise<void> {
  const binary = await resolveNotifyBinary()
  if (!binary) return
  const sound = watch.conclusion === "success" ? "Hero" : "Bottle"
  const title = watch.conclusion === "success" ? "swiz CI passed" : "swiz CI failed"
  const body = watch.runUrl
    ? `${watch.sha.slice(0, 8)} • ${watch.runUrl}`
    : `${watch.sha.slice(0, 8)} • run ${watch.runId ?? "unknown"}`
  const proc = Bun.spawn(
    [binary, "--title", title, "--body", body, "--sound", sound, "--timeout", "20"],
    {
      stdout: "ignore",
      stderr: "ignore",
    }
  )
  await proc.exited
}

async function defaultCiRunFetcher(cwd: string, sha: string): Promise<CiWatchRun | null> {
  const runs = await ghJson<CiWatchRun[]>(
    ["run", "list", "--commit", sha, "--json", "databaseId,status,conclusion,url", "--limit", "1"],
    cwd
  )
  if (!Array.isArray(runs) || runs.length === 0) return null
  return runs[0] ?? null
}

export class CiWatchRegistry {
  private watches = new Map<string, CiWatchInternal>()
  private pollMs: number
  private timeoutMs: number
  private fetchRun: CiRunFetcher
  private notify: CiNotify

  constructor(
    opts: {
      pollMs?: number
      timeoutMs?: number
      fetchRun?: CiRunFetcher
      notify?: CiNotify
    } = {}
  ) {
    this.pollMs = opts.pollMs ?? CI_WATCH_POLL_MS
    this.timeoutMs = opts.timeoutMs ?? CI_WATCH_TIMEOUT_MS
    this.fetchRun = opts.fetchRun ?? defaultCiRunFetcher
    this.notify = opts.notify ?? defaultCiCompletionNotify
  }

  listActive(): CiWatchStatus[] {
    return [...this.watches.values()].map((w) => ({
      sha: w.sha,
      cwd: w.cwd,
      startedAt: w.startedAt,
      lastCheckedAt: w.lastCheckedAt,
      runId: w.runId,
      runUrl: w.runUrl,
    }))
  }

  start(cwd: string, sha: string): { deduped: boolean; watch: CiWatchStatus } {
    const key = ciWatchKey(cwd, sha)
    const existing = this.watches.get(key)
    if (existing) {
      return {
        deduped: true,
        watch: {
          sha: existing.sha,
          cwd: existing.cwd,
          startedAt: existing.startedAt,
          lastCheckedAt: existing.lastCheckedAt,
          runId: existing.runId,
          runUrl: existing.runUrl,
        },
      }
    }

    const watch: CiWatchInternal = {
      sha,
      cwd,
      startedAt: Date.now(),
      lastCheckedAt: null,
      runId: null,
      runUrl: null,
      deadlineAt: Date.now() + this.timeoutMs,
      timer: null,
    }
    this.watches.set(key, watch)
    this.schedulePoll(key)

    return {
      deduped: false,
      watch: {
        sha: watch.sha,
        cwd: watch.cwd,
        startedAt: watch.startedAt,
        lastCheckedAt: watch.lastCheckedAt,
        runId: watch.runId,
        runUrl: watch.runUrl,
      },
    }
  }

  close(): void {
    for (const watch of this.watches.values()) {
      if (watch.timer) clearTimeout(watch.timer)
      watch.timer = null
    }
    this.watches.clear()
  }

  private schedulePoll(key: string): void {
    const watch = this.watches.get(key)
    if (!watch) return
    watch.timer = setTimeout(() => {
      void this.poll(key)
    }, this.pollMs)
  }

  private async poll(key: string): Promise<void> {
    const watch = this.watches.get(key)
    if (!watch) return

    if (Date.now() > watch.deadlineAt) {
      this.watches.delete(key)
      await this.notify({ ...watch, conclusion: "timeout" })
      return
    }

    watch.lastCheckedAt = Date.now()
    const run = await this.fetchRun(watch.cwd, watch.sha)
    if (run?.databaseId) {
      watch.runId = run.databaseId
      watch.runUrl = run.url ?? null
      const status = (run.status ?? "").toLowerCase()
      if (status === "completed") {
        const conclusion = (run.conclusion ?? "unknown").toLowerCase()
        this.watches.delete(key)
        await this.notify({ ...watch, conclusion })
        return
      }
    }

    this.schedulePoll(key)
  }
}
