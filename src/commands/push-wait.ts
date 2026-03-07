import { existsSync, readFileSync } from "node:fs"
import { getCanonicalPathHash } from "../git-helpers.ts"
import type { Command } from "../types.ts"

// Must match the values in hooks/pretooluse-push-cooldown.ts
export const COOLDOWN_MS = 60_000
const SENTINEL_PREFIX = "/tmp/swiz-push-cooldown-"
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
  return `${SENTINEL_PREFIX}${repoKey}.timestamp`
}

export function getRemainingCooldownMs(sentinelPath: string): number {
  try {
    if (!existsSync(sentinelPath)) return 0
    const raw = readFileSync(sentinelPath, "utf8").trim()
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
      timeout = parseInt(next, 10)
      if (Number.isNaN(timeout) || timeout <= 0) {
        throw new Error("Timeout must be a positive number")
      }
      i++
    } else if (arg === "--cwd" && next) {
      cwd = next
      i++
    } else if (arg.startsWith("-")) {
      extraArgs.push(arg)
    } else {
      positional.push(arg)
    }
  }

  if (positional.length >= 1 && positional[0]) remote = positional[0]
  if (positional.length >= 2 && positional[1]) branch = positional[1]

  return { remote, branch, timeout, extraArgs, cwd }
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
      throw new Error(`git push failed with exit code ${proc.exitCode}`)
    }

    console.log("✓ Push succeeded")
  },
}
