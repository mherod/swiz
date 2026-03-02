import type { Command } from "../types.ts"

// ─── Polling utilities ─────────────────────────────────────────────────────

async function getCiRunConclusion(commitSha: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(
      ["gh", "run", "list", "--commit", commitSha, "--json", "databaseId,conclusion,status"],
      { stdout: "pipe", stderr: "pipe" }
    )
    const output = await new Response(proc.stdout).text()
    await proc.exited

    if (proc.exitCode !== 0) return null

    const runs = JSON.parse(output)
    if (!Array.isArray(runs) || runs.length === 0) return null

    const run = runs[0]
    return run.conclusion || null // Returns "success", "failure", or empty string if still running
  } catch {
    return null
  }
}

async function waitForCiCompletion(
  commitSha: string,
  timeoutSeconds: number = 300
): Promise<{ conclusion: string; elapsed: number }> {
  const startTime = Date.now()
  const timeoutMs = timeoutSeconds * 1000

  return new Promise((resolve, reject) => {
    const pollInterval = 2000 // 2 second poll interval
    let lastLogged = 0

    const pollTimer = setInterval(async () => {
      const elapsed = Date.now() - startTime

      // Log progress every 10 seconds
      if (elapsed - lastLogged >= 10000) {
        console.log(`⏳ Waiting for CI... (${Math.round(elapsed / 1000)}s)`)
        lastLogged = elapsed
      }

      // Check timeout
      if (elapsed > timeoutMs) {
        clearInterval(pollTimer)
        reject(new Error(`CI run timeout after ${timeoutSeconds}s`))
        return
      }

      const conclusion = await getCiRunConclusion(commitSha)

      // conclusion is "success", "failure", or null/empty if still running
      if (conclusion && conclusion.length > 0) {
        clearInterval(pollTimer)
        resolve({ conclusion, elapsed })
      }
    }, pollInterval)
  })
}

// ─── Arg parsing ──────────────────────────────────────────────────────────

export interface CiWaitArgs {
  commitSha: string
  timeout: number
}

export function parseCiWaitArgs(args: string[]): CiWaitArgs {
  let commitSha = ""
  let timeout = 300 // 5 minutes default

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
  description: "Poll GitHub Actions run status for a commit until completion",
  usage: "swiz ci-wait <commit-sha> [--timeout <seconds>]",
  options: [{ flags: "--timeout, -t <seconds>", description: "Timeout in seconds (default: 300)" }],
  async run(args) {
    const { commitSha, timeout } = parseCiWaitArgs(args)

    try {
      console.log(`⏳ Waiting for CI run for commit ${commitSha.slice(0, 8)}...`)
      const { conclusion, elapsed } = await waitForCiCompletion(commitSha, timeout)

      const elapsedSeconds = Math.round(elapsed / 1000)
      console.log(`✓ CI completed in ${elapsedSeconds}s: conclusion = ${conclusion}`)

      // Set exit code based on conclusion
      if (conclusion === "success") {
        process.exitCode = 0
      } else if (conclusion === "failure") {
        console.error("✗ CI run failed")
        process.exitCode = 1
      } else {
        console.error(`✗ Unexpected conclusion: ${conclusion}`)
        process.exitCode = 2
      }
    } catch (err) {
      console.error(`✗ Error: ${String(err)}`)
      process.exitCode = 1
    }
  },
}
