/** Check if a binary exists on PATH. Returns its path or null. */
export async function whichExists(binary: string): Promise<string | null> {
  const proc = Bun.spawn(["which", binary], { stdout: "pipe", stderr: "pipe" })
  const stdout = await new Response(proc.stdout).text()
  await proc.exited
  return proc.exitCode === 0 ? stdout.trim() : null
}
