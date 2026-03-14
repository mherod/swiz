import { stderrLog } from "../debug.ts"
import type { Command } from "../types.ts"

// ─── Utilities ────────────────────────────────────────────────────────────
const DAEMON_PORT = Number(process.env.SWIZ_DAEMON_PORT ?? "7943")
const DAEMON_ORIGIN = process.env.SWIZ_DAEMON_ORIGIN ?? `http://127.0.0.1:${DAEMON_PORT}`

export interface CiWatchStartResponse {
  deduped: boolean
  watch: {
    sha: string
    cwd: string
    startedAt: number
    lastCheckedAt: number | null
    runId: number | null
    runUrl: string | null
  }
}

export async function startCiWatchViaDaemon(
  sha: string,
  cwd: string
): Promise<CiWatchStartResponse | null> {
  try {
    const resp = await fetch(`${DAEMON_ORIGIN}/ci-watch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sha, cwd }),
      signal: AbortSignal.timeout(1500),
    })
    if (!resp.ok) return null
    return (await resp.json()) as CiWatchStartResponse
  } catch {
    return null
  }
}

/**
 * Expand a short or full SHA to its full 40-character form using `git rev-parse`.
 * Falls back to the original string if rev-parse fails (e.g. not in a git repo).
 * This is necessary because `gh run list --commit` only matches full SHAs.
 */
export async function expandSha(sha: string): Promise<string> {
  if (sha.length === 40) return sha
  try {
    const proc = Bun.spawn(["git", "rev-parse", sha], { stdout: "pipe", stderr: "pipe" })
    const [output] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    await proc.exited
    const full = output.trim()
    return full.length === 40 ? full : sha
  } catch {
    return sha
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export async function findRunId(fullSha: string): Promise<number | null> {
  try {
    const proc = Bun.spawn(
      ["gh", "run", "list", "--commit", fullSha, "--json", "databaseId", "--jq", ".[0].databaseId"],
      { stdout: "pipe", stderr: "pipe" }
    )
    const [output] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    await proc.exited
    if (proc.exitCode !== 0) return null
    const id = parseInt(output.trim(), 10)
    return Number.isNaN(id) ? null : id
  } catch {
    return null
  }
}

// ─── Core: discover run then stream via gh run watch ──────────────────────

export async function waitForCiCompletion(
  commitSha: string,
  timeoutSeconds: number = 300
): Promise<{ conclusion: string; elapsed: number }> {
  const startTime = Date.now()
  const timeoutMs = timeoutSeconds * 1000
  const discoveryPollMs = 5_000

  const fullSha = await expandSha(commitSha)

  // Phase 1: Discover the run ID
  let runId: number | null = null
  while (runId === null) {
    const elapsed = Date.now() - startTime
    if (elapsed > timeoutMs) {
      throw new Error(`No CI run found for commit ${commitSha} within ${timeoutSeconds}s timeout`)
    }
    runId = await findRunId(fullSha)
    if (runId === null) {
      console.log(`⏳ Waiting for CI run to appear... (${Math.round(elapsed / 1000)}s)`)
      await sleep(discoveryPollMs)
    }
  }

  console.log(`Found CI run ${runId} — streaming output:\n`)

  // Phase 2: Stream live output via gh run watch (stdout/stderr inherited)
  const watchProc = Bun.spawn(["gh", "run", "watch", String(runId), "--exit-status"], {
    stdout: "inherit",
    stderr: "inherit",
  })

  // Apply timeout: kill gh run watch if it exceeds the remaining budget
  const remainingMs = timeoutMs - (Date.now() - startTime)
  const killTimer = setTimeout(
    () => {
      watchProc.kill()
    },
    Math.max(remainingMs, 0)
  )

  await watchProc.exited
  clearTimeout(killTimer)

  const elapsed = Date.now() - startTime

  if (watchProc.exitCode === 0) {
    return { conclusion: "success", elapsed }
  }

  // gh run watch --exit-status exits non-zero on failure
  // Check if it was killed by our timeout
  if (Date.now() - startTime >= timeoutMs) {
    throw new Error(`CI run ${runId} still running after ${timeoutSeconds}s timeout`)
  }

  return { conclusion: "failure", elapsed }
}

// ─── Arg parsing ──────────────────────────────────────────────────────────

export interface CiWaitArgs {
  commitSha: string
  timeout: number
}

export function parseCiWaitArgs(args: string[]): CiWaitArgs {
  let commitSha = ""
  let timeout = 300

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
    } else if (!arg.startsWith("-")) {
      commitSha = arg
    }
  }

  if (!commitSha) {
    throw new Error("Commit SHA is required")
  }

  return { commitSha, timeout }
}

// ─── Command ──────────────────────────────────────────────────────────────

export const ciWaitCommand: Command = {
  name: "ci-wait",
  description: "Wait for GitHub Actions CI run and stream live output",
  usage: "swiz ci-wait <commit-sha> [--timeout <seconds>]",
  options: [{ flags: "--timeout, -t <seconds>", description: "Timeout in seconds (default: 300)" }],
  async run(args) {
    const { commitSha, timeout } = parseCiWaitArgs(args)

    try {
      console.log(`⏳ Waiting for CI run for commit ${commitSha.slice(0, 8)}...`)
      const { conclusion, elapsed } = await waitForCiCompletion(commitSha, timeout)

      const elapsedSeconds = Math.round(elapsed / 1000)
      console.log(`\n✓ CI completed in ${elapsedSeconds}s: ${conclusion}`)

      if (conclusion === "success") {
        process.exitCode = 0
      } else {
        stderrLog("CI failure status reporting with exit codes", `✗ CI run: ${conclusion}`)
        process.exitCode = 1
      }
    } catch (err) {
      const errMsg = String(err)
      stderrLog("CI failure status reporting with exit codes", `✗ Error: ${errMsg}`)
      process.exitCode = errMsg.includes("timeout") ? 1 : 2
    }
  },
}
