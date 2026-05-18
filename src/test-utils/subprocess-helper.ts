// Subprocess helper for test utilities.
// Provides a wrapper around Bun.spawn that ensures stdout/stderr are drained
// concurrently using Promise.all() to prevent pipe buffer deadlock.

export interface SubprocessResult {
  stdout: string
  stderr: string
  exitCode: number | null
}

export interface SubprocessOptions {
  cwd?: string
  env?: Record<string, string>
}

// Spawn a subprocess and drain stdout/stderr concurrently to prevent deadlock.
// Per CLAUDE.md guidelines, concurrent drain using Promise.all() prevents pipe
// buffer overflow under CI load that can cause test timeouts.
export async function spawnAndCapture(
  cmd: string[],
  options: SubprocessOptions = {}
): Promise<SubprocessResult> {
  const proc = Bun.spawn(cmd, {
    cwd: options.cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: options.env,
  })

  if (proc.stdin) {
    void proc.stdin.end()
  }

  // Drain stdout and stderr CONCURRENTLY using Promise.all() to prevent deadlock.
  // Sequential draining (await stdout, then await stderr) can cause pipe buffer
  // overflow when stderr fills while waiting for stdout to complete.
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])

  await proc.exited

  return {
    stdout,
    stderr,
    exitCode: proc.exitCode,
  }
}
