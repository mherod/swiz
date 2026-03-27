import { basename } from "node:path"
import { ghJson } from "../../git-helpers.ts"
import { appendHookLog } from "../../hook-log.ts"

/**
 * Verify a GitHub webhook HMAC-SHA256 signature.
 *
 * @param secret  The webhook secret configured in GitHub
 * @param body    Raw request body bytes
 * @param sigHeader  Value of the `X-Hub-Signature-256` header (e.g. "sha256=abc...")
 * @returns true if the signature is valid, false otherwise
 */
export async function verifyWebhookSignature(
  secret: string,
  body: ArrayBuffer,
  sigHeader: string | null
): Promise<boolean> {
  if (!sigHeader?.startsWith("sha256=")) return false
  const expected = sigHeader.slice("sha256=".length)
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )
  const mac = await crypto.subtle.sign("HMAC", key, body)
  const actual = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
  // Constant-time comparison
  if (actual.length !== expected.length) return false
  let diff = 0
  for (let i = 0; i < actual.length; i++) {
    diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i)
  }
  return diff === 0
}

const CI_WATCH_POLL_MS = 30_000
const CI_WATCH_TIMEOUT_MS = 60 * 60 * 1000
const MIN_POLL_INTERVAL_MS = 1_000

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
    this.pollMs = Math.max(opts.pollMs ?? CI_WATCH_POLL_MS, MIN_POLL_INTERVAL_MS)
    this.timeoutMs = opts.timeoutMs ?? CI_WATCH_TIMEOUT_MS
    this.fetchRun = opts.fetchRun ?? defaultCiRunFetcher
    this.notify = opts.notify ?? (async () => {})
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

  /**
   * Handle a webhook-delivered conclusion for a given commit SHA.
   *
   * Finds any active watch matching the SHA (across all cwds), cancels its
   * poll timer, and calls the notify callback immediately. Returns the number
   * of watches that were resolved.
   */
  async handleWebhookConclusion(sha: string, conclusion: string, runId: number): Promise<number> {
    let resolved = 0
    for (const [key, watch] of this.watches) {
      if (watch.sha !== sha) continue
      if (watch.timer) clearTimeout(watch.timer)
      watch.timer = null
      watch.runId = runId
      watch.lastCheckedAt = Date.now()
      this.watches.delete(key)
      await this.notify({ ...watch, conclusion })
      resolved++
    }
    return resolved
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

/**
 * Notify the user when a CI run completes via macOS notification center
 * and log the completion to the hook log for the daemon logs view.
 */
export async function notifyCiCompletion(
  watch: CiWatchStatus & { conclusion: string }
): Promise<void> {
  const shortSha = watch.sha.slice(0, 8)
  const project = basename(watch.cwd)
  const passed = watch.conclusion === "success"
  const title = passed ? "CI passed" : `CI ${watch.conclusion}`
  const message = `${project} @ ${shortSha}`
  const sound = passed ? "Glass" : "Sosumi"

  // macOS notification via osascript
  try {
    const proc = Bun.spawn(
      [
        "osascript",
        "-e",
        `display notification "${message}" with title "${title}" sound name "${sound}"`,
      ],
      { stdout: "ignore", stderr: "ignore" }
    )
    await proc.exited
  } catch {
    // Non-macOS or osascript unavailable — skip silently
  }

  // Log to hook-logs so it appears in the daemon logs view
  void appendHookLog({
    ts: new Date().toISOString(),
    event: "ciWatch",
    hookEventName: "CiWatch",
    hook: "ci-notify",
    status: passed ? "ok" : "error",
    durationMs: Date.now() - watch.startedAt,
    exitCode: null,
    kind: "dispatch",
    hookCount: 0,
    cwd: watch.cwd,
  })
}
