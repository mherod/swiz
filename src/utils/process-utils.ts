import type { Subprocess } from "bun"

/** Grace period before escalating SIGTERM → SIGKILL (ms). */
const SUBPROCESS_SIGKILL_GRACE_MS = 3_000

/**
 * After SIGKILL, how long to keep waiting for the pipes to close (ms). A
 * descendant that escaped the process group can hold them open forever; past
 * this point the output is abandoned so the caller is never left hanging.
 */
const POST_SIGKILL_DRAIN_MS = 1_000

export interface SpawnWithTimeoutResult {
  stdout: string
  stderr: string
  exitCode: number | null
  timedOut: boolean
  aborted?: boolean
  /** SIGTERM was not enough; the process (group) was sent SIGKILL. */
  killEscalated?: boolean
  /** Pipes stayed open after SIGKILL; output was dropped rather than awaited. */
  outputAbandoned?: boolean
}

/** Drain both pipes concurrently, then wait for a reliable exit code. */
export async function collectProcessOutput(
  proc: Subprocess<"pipe" | "ignore", "pipe", "pipe">
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited
  return { stdout, stderr, exitCode: proc.exitCode }
}

/**
 * Signal a whole process group (negative pid). Returns false when the group no
 * longer exists or cannot be signalled, so callers can fall back to the leader.
 */
export function signalProcessGroup(pid: number, signalName: "SIGTERM" | "SIGKILL"): boolean {
  if (process.platform === "win32" || !Number.isInteger(pid) || pid <= 1) return false
  try {
    process.kill(-pid, signalName)
    return true
  } catch {
    return false
  }
}

type PipedSubprocess = Subprocess<"pipe" | "ignore", "pipe", "pipe">

interface TerminationFlags {
  timedOut: boolean
  aborted?: boolean
  killEscalated?: boolean
}

interface ProcessSupervisor {
  /** Resolves once the pipes are given up on after SIGKILL. */
  abandoned: Promise<"abandoned">
  flags: () => TerminationFlags
  dispose: () => void
}

/**
 * Arm the timeout and abort handling for a running subprocess: SIGTERM, then
 * SIGKILL after the grace period, then abandon the pipes if they stay open.
 */
function superviseProcess(
  proc: PipedSubprocess,
  opts: { detached: boolean; timeoutMs: number; sigkillGraceMs: number; signal?: AbortSignal }
): ProcessSupervisor {
  const state: TerminationFlags = { timedOut: false }
  let sigkillTimer: ReturnType<typeof setTimeout> | undefined
  let abandonTimer: ReturnType<typeof setTimeout> | undefined
  let abandon: () => void = () => {}
  const abandoned = new Promise<"abandoned">((resolve) => {
    abandon = () => resolve("abandoned")
  })

  const kill = (signalName: "SIGTERM" | "SIGKILL") => {
    // The group outlives its leader, so signal it even after the runner exited.
    if (opts.detached && signalProcessGroup(proc.pid, signalName)) return
    try {
      proc.kill(signalName)
    } catch {
      // Already gone.
    }
  }
  const terminate = () => {
    if (sigkillTimer) return
    kill("SIGTERM")
    sigkillTimer = setTimeout(() => {
      state.killEscalated = true
      kill("SIGKILL")
      abandonTimer = setTimeout(abandon, POST_SIGKILL_DRAIN_MS)
    }, opts.sigkillGraceMs)
  }
  const onAbort = () => {
    state.aborted = true
    terminate()
  }
  const timer = setTimeout(() => {
    state.timedOut = true
    terminate()
  }, opts.timeoutMs)
  opts.signal?.addEventListener("abort", onAbort, { once: true })
  if (opts.signal?.aborted) onAbort()

  return {
    abandoned,
    flags: () => ({ ...state }),
    dispose: () => {
      clearTimeout(timer)
      clearTimeout(sigkillTimer)
      clearTimeout(abandonTimer)
      opts.signal?.removeEventListener("abort", onAbort)
    },
  }
}

async function writeProcessStdin(proc: PipedSubprocess, stdin: string | undefined): Promise<void> {
  const sink = proc.stdin
  if (stdin === undefined || !sink) return
  await sink.write(stdin)
  await sink.end()
}

/**
 * Spawn a subprocess with a hard timeout. On expiry, sends SIGTERM then
 * escalates to SIGKILL after the grace period. Returns stdout, stderr,
 * exit code, and whether the timeout fired.
 *
 * The timers are armed before stdin is written, so a child that never reads
 * its stdin is still terminated on schedule.
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
    env?: Record<string, string | undefined>
    timeoutMs?: number
    stdin?: string
    signal?: AbortSignal
    /** Isolate and terminate script descendants along with their runner on POSIX. */
    killProcessGroup?: boolean
    /** Override the SIGTERM → SIGKILL grace period (ms). */
    sigkillGraceMs?: number
    /** Called with the child pid immediately after spawn. */
    onSpawn?: (pid: number) => void
  } = {}
): Promise<SpawnWithTimeoutResult> {
  const { cwd, env, timeoutMs = 30_000, stdin, signal } = opts
  const detached = opts.killProcessGroup === true && process.platform !== "win32"
  if (signal?.aborted) {
    return { stdout: "", stderr: "", exitCode: null, timedOut: false, aborted: true }
  }

  const proc = Bun.spawn(cmd, {
    cwd,
    env,
    detached,
    stdin: stdin !== undefined ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  opts.onSpawn?.(proc.pid)

  const supervisor = superviseProcess(proc, {
    detached,
    timeoutMs,
    sigkillGraceMs: opts.sigkillGraceMs ?? SUBPROCESS_SIGKILL_GRACE_MS,
    signal,
  })
  try {
    const collected = Promise.all([
      writeProcessStdin(proc, stdin),
      collectProcessOutput(proc),
    ]).then(([, output]) => output)
    const outcome = await Promise.race([collected, supervisor.abandoned])
    if (outcome !== "abandoned") return { ...outcome, ...supervisor.flags() }
    // Stop tracking the pipes: nothing we own is still alive behind them.
    collected.catch(() => {})
    proc.unref()
    return {
      stdout: "",
      stderr: "",
      exitCode: proc.exitCode,
      ...supervisor.flags(),
      outputAbandoned: true,
    }
  } finally {
    supervisor.dispose()
  }
}
