import type { Subprocess } from "bun"

/** Grace period before escalating SIGTERM → SIGKILL (ms). */
const SUBPROCESS_SIGKILL_GRACE_MS = 3_000

export interface SpawnWithTimeoutResult {
  stdout: string
  stderr: string
  exitCode: number | null
  timedOut: boolean
  aborted?: boolean
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
  opts: {
    cwd?: string
    timeoutMs?: number
    stdin?: string
    signal?: AbortSignal
    /** Isolate and terminate script descendants along with their runner on POSIX. */
    killProcessGroup?: boolean
  } = {}
): Promise<SpawnWithTimeoutResult> {
  const { cwd, timeoutMs = 30_000, stdin, signal } = opts
  const detached = opts.killProcessGroup === true && process.platform !== "win32"
  if (signal?.aborted) {
    return { stdout: "", stderr: "", exitCode: null, timedOut: false, aborted: true }
  }

  const finish = async (
    proc: Subprocess<"pipe" | "ignore", "pipe", "pipe">
  ): Promise<SpawnWithTimeoutResult> => {
    let timedOut = false
    let aborted = false
    let sigkillTimer: ReturnType<typeof setTimeout> | undefined
    const kill = (signalName: "SIGTERM" | "SIGKILL") => {
      if (detached) {
        try {
          process.kill(-proc.pid, signalName)
        } catch (error) {
          if ((error as { code?: string }).code !== "ESRCH") proc.kill(signalName)
        }
      } else {
        proc.kill(signalName)
      }
    }
    const terminate = () => {
      if (sigkillTimer) return
      kill("SIGTERM")
      sigkillTimer = setTimeout(() => {
        kill("SIGKILL")
      }, SUBPROCESS_SIGKILL_GRACE_MS)
    }
    const onAbort = () => {
      aborted = true
      terminate()
    }
    const timer = setTimeout(() => {
      timedOut = true
      terminate()
    }, timeoutMs)
    signal?.addEventListener("abort", onAbort, { once: true })
    if (signal?.aborted) onAbort()

    try {
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      await proc.exited
      return {
        stdout,
        stderr,
        exitCode: proc.exitCode,
        timedOut,
        ...(aborted ? { aborted: true } : {}),
      }
    } finally {
      clearTimeout(timer)
      if (sigkillTimer) clearTimeout(sigkillTimer)
      signal?.removeEventListener("abort", onAbort)
    }
  }

  if (stdin !== undefined) {
    const proc = Bun.spawn(cmd, {
      cwd,
      detached,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    await proc.stdin.write(stdin)
    await proc.stdin.end()
    return finish(proc)
  }

  return finish(
    Bun.spawn(cmd, {
      cwd,
      detached,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
  )
}
