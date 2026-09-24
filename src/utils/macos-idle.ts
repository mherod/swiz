import { spawnWithTimeout } from "./process-utils.ts"

/** IOHIDSystem reports elapsed input idle time in nanoseconds. */
export function parseMacOSIdleSeconds(output: string): number | null {
  const matches = [...output.matchAll(/"HIDIdleTime"\s*=\s*(\d+)\s*$/gm)]
  if (matches.length === 0) return null
  const seconds = matches.map((match) => Number(match[1]) / 1_000_000_000)
  return seconds.every(Number.isFinite) ? Math.min(...seconds) : null
}

/** A failed or unsupported probe is unknown, never evidence that the user is away. */
export async function readMacOSIdleSeconds(
  platform = process.platform,
  run: typeof spawnWithTimeout = spawnWithTimeout
): Promise<number | null> {
  if (platform !== "darwin") return null
  try {
    const result = await run(["/usr/sbin/ioreg", "-r", "-c", "IOHIDSystem", "-d", "1"], {
      timeoutMs: 1_000,
    })
    if (result.exitCode !== 0 || result.timedOut || result.aborted) return null
    return parseMacOSIdleSeconds(result.stdout)
  } catch {
    return null
  }
}
