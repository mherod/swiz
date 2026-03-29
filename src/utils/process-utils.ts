import type { Subprocess } from "bun"

/** Grace period before escalating SIGTERM → SIGKILL (ms). */
const SUBPROCESS_SIGKILL_GRACE_MS = 3_000

export interface SpawnWithTimeoutResult {
  stdout: string
  stderr: string
  exitCode: number | null
  timedOut: boolean
}

/**
 * Spawn a subprocess with a hard timeout. On expiry, sends SIGTERM then
 * escalates to SIGKILL after the grace period. Returns stdout, stderr,
 * exit code, and whether the timeout fired.
 *
 * @param cmd  Command array, e.g. `["bun", "run", "lint"]`
 * @param opts
 * @param opts.cwd  Working directory for the subprocess
 * @param opts.timeoutMs  Hard timeout in milliseconds (default: 30_000)
 * @param opts.stdin  Optional stdin content to pipe into the process
 */
export async function spawnWithTimeout(
  cmd: string[],
  opts: { cwd?: string; timeoutMs?: number; stdin?: string } = {}
): Promise<SpawnWithTimeoutResult> {
  const { cwd, timeoutMs = 30_000, stdin } = opts

  const finish = async (
    proc: Subprocess<"pipe" | "ignore", "pipe", "pipe">
  ): Promise<SpawnWithTimeoutResult> => {
    let timedOut = false
    let sigkillTimer: ReturnType<typeof setTimeout> | undefined
    const timer = setTimeout(() => {
      timedOut = true
      proc.kill("SIGTERM")
      sigkillTimer = setTimeout(() => {
        proc.kill("SIGKILL")
      }, SUBPROCESS_SIGKILL_GRACE_MS)
    }, timeoutMs)

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    await proc.exited
    clearTimeout(timer)
    if (sigkillTimer) clearTimeout(sigkillTimer)

    return {
      stdout,
      stderr,
      exitCode: proc.exitCode,
      timedOut,
    }
  }

  if (stdin !== undefined) {
    const proc = Bun.spawn(cmd, {
      cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    void proc.stdin.write(stdin)
    void proc.stdin.end()
    return finish(proc)
  }

  return finish(
    Bun.spawn(cmd, {
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
  )
}
