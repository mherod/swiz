import { acquireGhSlot } from "../gh-rate-limit.ts"
import { getCanonicalPathHash } from "../git-helpers.ts"
import { swizPushCooldownSentinelPath, swizPushResultPath } from "../temp-paths.ts"
import type { Command } from "../types.ts"
import { expandSha, findRunId, startCiWatchViaDaemon } from "./ci-wait.ts"

// Must match the values in hooks/pretooluse-push-cooldown.ts
export const COOLDOWN_MS = 60_000
const POLL_INTERVAL_MS = 2_000
const CI_POLL_INTERVAL_MS = 10_000

// ─── CI polling ──────────────────────────────────────────────────────────

interface GhRunJob {
  name: string
  conclusion: string | null
  status: string
}

interface GhRunViewResult {
  conclusion: string | null
  status: string
  jobs: GhRunJob[]
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function evaluateRunResult(data: GhRunViewResult, runId: number): "success" | "pending" | Error {
  const { conclusion, status, jobs } = data
  if (status !== "completed") return "pending"
  if (conclusion !== "success") {
    return new Error(`CI run ${runId} completed with conclusion: ${conclusion ?? "unknown"}`)
  }
  const failed = jobs.filter((j) => j.conclusion !== "success")
  if (failed.length === 0) {
    console.log(`✓ All ${jobs.length} CI job(s) reached conclusion=success`)
    return "success"
  }
  const names = failed.map((j) => `${j.name} (${j.conclusion ?? "null"})`).join(", ")
  return new Error(`CI completed but some jobs did not succeed: ${names}`)
}

async function discoverRunId(
  fullSha: string,
  commitSha: string,
  startTime: number,
  timeoutMs: number
): Promise<number> {
  let runId: number | null = null
  while (runId === null) {
    const elapsed = Date.now() - startTime
    if (elapsed > timeoutMs) {
      throw new Error(
        `No CI run found for commit ${commitSha} within ${Math.round(timeoutMs / 1000)}s`
      )
    }
    runId = await findRunId(fullSha)
    if (runId === null) {
      console.log(`⏳ Waiting for CI run... (${Math.round(elapsed / 1000)}s)`)
      await sleep(CI_POLL_INTERVAL_MS)
    }
  }
  return runId
}

export async function pollUntilAllJobsSuccess(
  commitSha: string,
  timeoutSeconds: number,
  cwd?: string
): Promise<void> {
  const startTime = Date.now()
  const timeoutMs = timeoutSeconds * 1000

  const fullSha = await expandSha(commitSha)
  const runId = await discoverRunId(fullSha, commitSha, startTime, timeoutMs)
  console.log(`✓ CI run ${runId} found — polling for job completion...`)

  // Phase 2: poll gh run view until all jobs reach conclusion=success
  while (true) {
    const elapsed = Date.now() - startTime
    if (elapsed > timeoutMs) {
      throw new Error(`CI run ${runId} did not complete within ${timeoutSeconds}s timeout`)
    }

    await acquireGhSlot()
    const proc = Bun.spawn(
      ["gh", "run", "view", String(runId), "--json", "conclusion,status,jobs"],
      { stdout: "pipe", stderr: "pipe", ...(cwd ? { cwd } : {}) }
    )
    const [output] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    await proc.exited

    if (proc.exitCode !== 0) {
      await sleep(CI_POLL_INTERVAL_MS)
      continue
    }

    let data: GhRunViewResult
    try {
      data = JSON.parse(output) as GhRunViewResult
    } catch {
      await sleep(CI_POLL_INTERVAL_MS)
      continue
    }

    const pollResult = evaluateRunResult(data, runId)
    if (pollResult === "success") return
    if (pollResult instanceof Error) throw pollResult

    const done = data.jobs.filter((j) => j.conclusion !== null).length
    console.log(
      `⏳ CI: ${data.status} — ${done}/${data.jobs.length} job(s) done (${Math.round(elapsed / 1000)}s)`
    )
    await sleep(CI_POLL_INTERVAL_MS)
  }
}

// ─── Cooldown utilities ──────────────────────────────────────────────────

export function getSentinelPath(cwd: string): string {
  const proc = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  })
  const repoRoot = new TextDecoder().decode(proc.stdout).trim() || cwd
  const repoKey = getCanonicalPathHash(repoRoot)
  return swizPushCooldownSentinelPath(repoKey)
}

export function getRepoKey(cwd: string): string {
  const proc = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  })
  const repoRoot = new TextDecoder().decode(proc.stdout).trim() || cwd
  return getCanonicalPathHash(repoRoot)
}

export async function getRemainingCooldownMs(sentinelPath: string): Promise<number> {
  try {
    const file = Bun.file(sentinelPath)
    if (!(await file.exists())) return 0
    const raw = (await file.text()).trim()
    if (raw === "") return 0
    const lastPush = parseInt(raw, 10)
    if (Number.isNaN(lastPush)) return 0
    const remaining = COOLDOWN_MS - (Date.now() - lastPush)
    return remaining > 0 ? remaining : 0
  } catch {
    // Permission error, file disappeared between exists/read — treat as no cooldown
    return 0
  }
}

export interface WaitForCooldownOptions {
  sentinelPath: string
  timeoutSeconds: number
  pollIntervalMs?: number
  log?: (msg: string) => void
}

export async function waitForCooldown(opts: WaitForCooldownOptions): Promise<{ waitedMs: number }> {
  const { sentinelPath, timeoutSeconds, log = console.log } = opts
  const pollInterval = opts.pollIntervalMs ?? POLL_INTERVAL_MS
  const startTime = Date.now()
  const timeoutMs = timeoutSeconds * 1000

  // Check immediately — cooldown may already be clear
  const initial = await getRemainingCooldownMs(sentinelPath)
  if (initial === 0) {
    return { waitedMs: 0 }
  }

  log(`⏳ Push cooldown active — ${Math.ceil(initial / 1000)}s remaining`)

  while (true) {
    await Bun.sleep(pollInterval)
    const elapsed = Date.now() - startTime

    if (elapsed > timeoutMs) {
      const remaining = await getRemainingCooldownMs(sentinelPath)
      throw new Error(
        `Cooldown did not expire within ${timeoutSeconds}s timeout` +
          (remaining > 0 ? ` (${Math.ceil(remaining / 1000)}s still remaining)` : "")
      )
    }

    const remaining = await getRemainingCooldownMs(sentinelPath)
    if (remaining === 0) {
      log(`✓ Cooldown expired after ${Math.round(elapsed / 1000)}s`)
      return { waitedMs: elapsed }
    }
    log(`⏳ Cooldown: ${Math.ceil(remaining / 1000)}s remaining...`)
  }
}

// ─── Arg parsing ─────────────────────────────────────────────────────────

export interface PushWaitArgs {
  remote: string
  branch: string
  timeout: number
  wait: boolean
  extraArgs: string[]
  cwd?: string
}

function parsePositiveTimeout(raw: string): number {
  const timeout = parseInt(raw, 10)
  if (Number.isNaN(timeout) || timeout <= 0) {
    throw new Error("Timeout must be a positive number")
  }
  return timeout
}

export function parsePushWaitArgs(args: string[]): PushWaitArgs {
  let remote = "origin"
  let branch = ""
  let timeout = 120
  let wait = false
  let cwd: string | undefined
  const extraArgs: string[] = []
  const positional: string[] = []

  const valueFlags: Record<string, (v: string) => void> = {
    "--timeout": (v) => {
      timeout = parsePositiveTimeout(v)
    },
    "-t": (v) => {
      timeout = parsePositiveTimeout(v)
    },
    "--cwd": (v) => {
      cwd = v
    },
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg) continue

    const valueSetter = valueFlags[arg]
    if (valueSetter && args[i + 1]) {
      valueSetter(args[++i]!)
      continue
    }
    if (arg === "--wait") {
      wait = true
      continue
    }
    if (arg.startsWith("-")) {
      extraArgs.push(arg)
      continue
    }
    positional.push(arg)
  }

  remote = positional[0] || remote
  branch = positional[1] || branch

  return { remote, branch, timeout, wait, extraArgs, cwd }
}

// ─── Push result file ───────────────────────────────────────────────────

export interface PushResult {
  success: boolean
  commitSha: string
  branch: string
  remote: string
  exitCode: number
  timestamp: number
  ciWatchStarted: boolean
}

async function writePushResult(repoKey: string, result: PushResult): Promise<void> {
  try {
    await Bun.write(swizPushResultPath(repoKey), JSON.stringify(result, null, 2))
  } catch {
    // Non-fatal — result file is a convenience, not critical path
  }
}

// ─── Command ─────────────────────────────────────────────────────────────

export const pushWaitCommand: Command = {
  name: "push-wait",
  description: "Wait for push cooldown to expire, then push (optionally wait for CI)",
  usage: "swiz push-wait [remote] [branch] [--wait] [--cwd <dir>] [--timeout <seconds>]",
  options: [
    { flags: "--wait", description: "Poll gh run view until all CI jobs reach conclusion=success" },
    { flags: "--cwd <dir>", description: "Working directory for the git push (default: cwd)" },
    { flags: "--timeout, -t <seconds>", description: "Max wait for cooldown (default: 120)" },
  ],
  async run(args) {
    const { remote, branch, timeout, wait, extraArgs, cwd: cwdArg } = parsePushWaitArgs(args)
    const cwd = cwdArg ?? process.cwd()

    // Resolve branch from git if not provided
    let targetBranch = branch
    if (!targetBranch) {
      const proc = Bun.spawnSync(["git", "branch", "--show-current"], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      })
      targetBranch = new TextDecoder().decode(proc.stdout).trim()
      if (!targetBranch) {
        throw new Error("Could not determine current branch (detached HEAD?)")
      }
    }

    const headProc = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    })
    const commitSha = new TextDecoder().decode(headProc.stdout).trim()
    if (!commitSha) {
      throw new Error("Could not determine HEAD SHA")
    }

    const repoKey = getRepoKey(cwd)
    const sentinelPath = getSentinelPath(cwd)

    // Wait for cooldown to clear
    await waitForCooldown({ sentinelPath, timeoutSeconds: timeout })

    // Execute git push
    const pushArgs = ["push", ...extraArgs, remote, targetBranch]
    console.log(`→ git ${pushArgs.join(" ")}`)

    const proc = Bun.spawn(["git", ...pushArgs], {
      cwd,
      stdout: "inherit",
      stderr: "inherit",
    })
    await proc.exited

    if (proc.exitCode !== 0) {
      await writePushResult(repoKey, {
        success: false,
        commitSha,
        branch: targetBranch,
        remote,
        exitCode: proc.exitCode ?? 1,
        timestamp: Date.now(),
        ciWatchStarted: false,
      })
      throw new Error(`git push failed with exit code ${proc.exitCode}`)
    }

    console.log("✓ Push succeeded")

    if (wait) {
      console.log(`⏳ --wait: polling CI until all jobs reach conclusion=success...`)
      await pollUntilAllJobsSuccess(commitSha, timeout, cwd)
      await writePushResult(repoKey, {
        success: true,
        commitSha,
        branch: targetBranch,
        remote,
        exitCode: 0,
        timestamp: Date.now(),
        ciWatchStarted: false,
      })
      return
    }

    const watch = await startCiWatchViaDaemon(commitSha, cwd)
    const ciWatchStarted = watch !== null
    if (watch) {
      const mode = watch.deduped ? "already active" : "started"
      console.log(`✓ CI background watch ${mode} for ${commitSha.slice(0, 8)}`)
    } else {
      console.log(
        `⚠ Could not reach daemon for CI watch; run 'swiz daemon' to enable background CI notifications.`
      )
    }

    // Write structured result file so callers can retrieve push outcome
    // even if the background task record is cleaned up
    await writePushResult(repoKey, {
      success: true,
      commitSha,
      branch: targetBranch,
      remote,
      exitCode: 0,
      timestamp: Date.now(),
      ciWatchStarted,
    })
  },
}
