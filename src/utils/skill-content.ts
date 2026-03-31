const INLINE_CMD_RE = /!`([^`]+)`/g

/**
 * Expand inline commands in skill content: !`cmd` → stdout of cmd.
 */
export async function expandInlineCommands(content: string): Promise<string> {
  const matches = [...content.matchAll(INLINE_CMD_RE)]
  if (matches.length === 0) return content

  const results = await Promise.all(
    matches.map(async (m) => {
      const cmd = m[1]!
      try {
        const proc = Bun.spawn(["sh", "-c", cmd], {
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, PATH: process.env.PATH },
        })
        const [stdout] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ])
        await proc.exited
        return stdout.trim()
      } catch {
        return `[error running: ${cmd}]`
      }
    })
  )

  let i = 0
  return content.replace(INLINE_CMD_RE, () => results[i++]!)
}

/**
 * Substitute positional args in skill content: $0, $1, ..., $ARGUMENTS.
 */
export function substituteArgs(content: string, positionalArgs: string[]): string {
  if (positionalArgs.length === 0) return content
  let result = content
  // $ARGUMENTS → full space-joined remaining args
  result = result.replace(/\$ARGUMENTS\b/g, positionalArgs.join(" "))
  // $0, $1, … → individual positional args (empty string if out of range)
  for (let i = 0; i < positionalArgs.length; i++) {
    const escaped = positionalArgs[i]!.replace(/[$&`\\]/g, "\\$&")
    result = result.replace(new RegExp(`\\$${i}\\b`, "g"), escaped)
  }
  return result
}
