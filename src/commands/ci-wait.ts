import type { Command } from "../types.ts"

// ─── Polling utilities ─────────────────────────────────────────────────────

async function getCiRunConclusion(commitSha: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(
      ["gh", "run", "list", "--commit", commitSha, "--json", "databaseId,conclusion,status"],
      { stdout: "pipe", stderr: "pipe" }
    )
    const [output] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

async function waitForCiCompletion(
  commitSha: string,
  timeoutSeconds: number = 300
): Promise<{ conclusion: string; elapsed: number }> {
  const startTime = Date.now()
  const timeoutMs = timeoutSeconds * 1000
  const pollInterval = 2000
  let lastLogged = 0
  let foundAnyRun = false

  while (true) {
    const elapsed = Date.now() - startTime

    if (elapsed - lastLogged >= 10000) {
      console.log(`⏳ Waiting for CI... (${Math.round(elapsed / 1000)}s)`)
      lastLogged = elapsed
    }

    if (elapsed > timeoutMs) {
      if (foundAnyRun) {
        throw new Error(
          `CI run still running after ${timeoutSeconds}s timeout (run exists but has not completed)`
        )
      }
      throw new Error(
        `No CI run found for commit ${commitSha} within ${timeoutSeconds}s timeout (run may not have been created yet)`
      )
    }

    const conclusion = await getCiRunConclusion(commitSha)

    if (conclusion !== null) {
      foundAnyRun = true
    }

    if (conclusion && conclusion.length > 0) {
      return { conclusion, elapsed }
    }

    await sleep(pollInterval)
  }
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
      const errMsg = String(err)
      console.error(`✗ Error: ${errMsg}`)
      // Exit code 1 for timeout or CI failure; 2 for unexpected errors
      if (errMsg.includes("timeout")) {
        process.exitCode = 1
      } else {
        process.exitCode = 2
      }
    }
  },
}
