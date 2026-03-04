// push-ci: Wait for push cooldown, push to remote, then poll CI until conclusion.
//
// This combines push-wait + ci-wait into a single command so the agent never has to
// manually sequence: push → capture SHA → gh run list → gh run watch → gh run view.
// It emits the same CI verification evidence the manual sequence would produce,
// so transcript-based workflow checks can treat the result as verified.

import type { Command } from "../types.ts"
import { waitForCiCompletion } from "./ci-wait.ts"
import { getSentinelPath, parsePushWaitArgs, waitForCooldown } from "./push-wait.ts"

export interface PushCiArgs {
  remote: string
  branch: string
  cooldownTimeout: number
  ciTimeout: number
  cwd?: string
}

export function parsePushCiArgs(args: string[]): PushCiArgs {
  let ciTimeout = 300
  const remaining: string[] = []

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg) continue
    const next = args[i + 1]

    if ((arg === "--ci-timeout" || arg === "--ci-t") && next) {
      ciTimeout = parseInt(next, 10)
      if (Number.isNaN(ciTimeout) || ciTimeout <= 0) {
        throw new Error("CI timeout must be a positive number")
      }
      i++
    } else {
      remaining.push(arg)
    }
  }

  const { remote, branch, timeout: cooldownTimeout, cwd } = parsePushWaitArgs(remaining)
  return { remote, branch, cooldownTimeout, ciTimeout, cwd }
}

export const pushCiCommand: Command = {
  name: "push-ci",
  description: "Push to remote and wait for CI to pass (combines push-wait + ci-wait)",
  usage: "swiz push-ci [remote] [branch] [--cwd <dir>] [--timeout <s>] [--ci-timeout <s>]",
  options: [
    { flags: "--cwd <dir>", description: "Working directory for git push (default: cwd)" },
    { flags: "--timeout, -t <seconds>", description: "Max wait for push cooldown (default: 120)" },
    { flags: "--ci-timeout <seconds>", description: "Max wait for CI completion (default: 300)" },
  ],
  async run(args) {
    const { remote, branch, cooldownTimeout, ciTimeout, cwd: cwdArg } = parsePushCiArgs(args)
    const cwd = cwdArg ?? process.cwd()

    // Resolve branch if not provided
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

    // Capture HEAD SHA before push — the commit is already local
    const shaProc = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    })
    const commitSha = new TextDecoder().decode(shaProc.stdout).trim()
    if (!commitSha) {
      throw new Error("Could not determine HEAD SHA")
    }

    // 1. Wait for push cooldown
    const sentinelPath = getSentinelPath(cwd)
    await waitForCooldown({ sentinelPath, timeoutSeconds: cooldownTimeout })

    // 2. Push
    const pushArgs = ["push", remote, targetBranch]
    console.log(`→ git ${pushArgs.join(" ")}`)
    const pushProc = Bun.spawn(["git", ...pushArgs], {
      cwd,
      stdout: "inherit",
      stderr: "inherit",
    })
    await pushProc.exited
    if (pushProc.exitCode !== 0) {
      throw new Error(`git push failed with exit code ${pushProc.exitCode}`)
    }
    console.log(`✓ Push succeeded — SHA ${commitSha.slice(0, 8)}`)

    // 3. Poll CI for the pushed SHA
    console.log(`⏳ Waiting for CI run for commit ${commitSha.slice(0, 8)}...`)
    const { conclusion, elapsed } = await waitForCiCompletion(commitSha, ciTimeout)
    const elapsedSeconds = Math.round(elapsed / 1000)

    // 4. Emit a gh run view --json line so manual transcript scanners also see verification
    const runListProc = Bun.spawnSync(
      [
        "gh",
        "run",
        "list",
        "--commit",
        commitSha,
        "--json",
        "databaseId",
        "--jq",
        ".[0].databaseId",
      ],
      { cwd, stdout: "pipe", stderr: "pipe" }
    )
    const runId = new TextDecoder().decode(runListProc.stdout).trim()
    if (runId) {
      const viewProc = Bun.spawn(["gh", "run", "view", runId, "--json", "conclusion,status,jobs"], {
        cwd,
        stdout: "inherit",
        stderr: "pipe",
      })
      await Promise.all([new Response(viewProc.stderr).text(), viewProc.exited])
    }

    console.log(`✓ CI completed in ${elapsedSeconds}s — conclusion: ${conclusion}`)

    if (conclusion !== "success") {
      console.error(`✗ CI ${conclusion}`)
      process.exitCode = 1
    }
  },
}
