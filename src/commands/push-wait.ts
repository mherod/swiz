import { getCanonicalPathHash } from "../git-helpers.ts"
import { swizPushCooldownSentinelPath, swizPushResultPath } from "../temp-paths.ts"
import type { Command } from "../types.ts"
import { startCiWatchViaDaemon } from "./ci-wait.ts"

// Must match the values in hooks/pretooluse-push-cooldown.ts
export const COOLDOWN_MS = 60_000
const POLL_INTERVAL_MS = 2_000

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

export function getRemainingCooldownMs(sentinelPath: string): number {
  try {
    const file = Bun.file(sentinelPath)
    // Bun.file().size is 0 for non-existent files
    if (file.size === 0) return 0
    // Use spawnSync to read file synchronously (needed inside setInterval)
    const proc = Bun.spawnSync(["cat", sentinelPath], { stdout: "pipe", stderr: "pipe" })
    const raw = new TextDecoder().decode(proc.stdout).trim()
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
  const initial = getRemainingCooldownMs(sentinelPath)
  if (initial === 0) {
    return { waitedMs: 0 }
  }

  log(`⏳ Push cooldown active — ${Math.ceil(initial / 1000)}s remaining`)

  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      const elapsed = Date.now() - startTime

      // Timeout check — deterministic exit
      if (elapsed > timeoutMs) {
        clearInterval(timer)
        const remaining = getRemainingCooldownMs(sentinelPath)
        reject(
          new Error(
            `Cooldown did not expire within ${timeoutSeconds}s timeout` +
              (remaining > 0 ? ` (${Math.ceil(remaining / 1000)}s still remaining)` : "")
          )
        )
        return
      }

      const remaining = getRemainingCooldownMs(sentinelPath)
      if (remaining === 0) {
        clearInterval(timer)
        log(`✓ Cooldown expired after ${Math.round(elapsed / 1000)}s`)
        resolve({ waitedMs: elapsed })
      } else {
        log(`⏳ Cooldown: ${Math.ceil(remaining / 1000)}s remaining...`)
      }
    }, pollInterval)
  })
}

// ─── Arg parsing ─────────────────────────────────────────────────────────

export interface PushWaitArgs {
  remote: string
  branch: string
  timeout: number
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
  let cwd: string | undefined
  const extraArgs: string[] = []
  const positional: string[] = []

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg) continue
    const next = args[i + 1]

    if ((arg === "--timeout" || arg === "-t") && next) {
      timeout = parsePositiveTimeout(next)
      i++
      continue
    }

    if (arg === "--cwd" && next) {
      cwd = next
      i++
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

  return { remote, branch, timeout, extraArgs, cwd }
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
  description: "Wait for push cooldown to expire, then push",
  usage: "swiz push-wait [remote] [branch] [--cwd <dir>] [--timeout <seconds>]",
  options: [
    { flags: "--cwd <dir>", description: "Working directory for the git push (default: cwd)" },
    { flags: "--timeout, -t <seconds>", description: "Max wait for cooldown (default: 120)" },
  ],
  async run(args) {
    const { remote, branch, timeout, extraArgs, cwd: cwdArg } = parsePushWaitArgs(args)
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
