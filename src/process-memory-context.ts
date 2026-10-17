import { buildContextHookOutput, type SwizHookOutput, type SwizHookRunContext } from "./SwizHook.ts"
import { spawnWithTimeout } from "./utils/process-utils.ts"

/** ps reports resident memory in KiB on macOS and Linux. */
export const PROCESS_MEMORY_THRESHOLD_KIB = 24 * 1024 * 1024
const MAX_REPORTED_PROCESSES = 10

export interface ProcessMemoryUsage {
  pid: number
  rssKiB: number
  command: string
}

export function parseExcessiveProcessMemory(output: string): ProcessMemoryUsage[] {
  const processes: ProcessMemoryUsage[] = []
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line)
    if (!match) continue
    const pid = Number(match[1])
    const rssKiB = Number(match[2])
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(rssKiB)) continue
    if (rssKiB <= PROCESS_MEMORY_THRESHOLD_KIB) continue
    processes.push({ pid, rssKiB, command: match[3]! })
  }
  return processes.sort((a, b) => b.rssKiB - a.rssKiB || a.pid - b.pid)
}

export function formatProcessMemoryContext(processes: ProcessMemoryUsage[]): string {
  if (processes.length === 0) return ""
  const lines = ["Excess RAM usage: processes exceeding 24 GiB of resident memory (RSS):"]
  for (const process of processes.slice(0, MAX_REPORTED_PROCESSES)) {
    const name = process.command.split("/").pop()!.slice(0, 160)
    const gib = (process.rssKiB / (1024 * 1024)).toFixed(2)
    lines.push(`- PID ${process.pid}: ${JSON.stringify(name)} — ${gib} GiB RSS`)
  }
  if (processes.length > MAX_REPORTED_PROCESSES) {
    lines.push(`- ${processes.length - MAX_REPORTED_PROCESSES} additional processes exceed 24 GiB.`)
  }
  lines.push("Inspect these processes before starting more memory-intensive work.")
  return lines.join("\n")
}

async function readProcessMemoryContext(
  context: SwizHookRunContext,
  run: typeof spawnWithTimeout
): Promise<string> {
  try {
    const result = await run(["ps", "-axo", "pid=,rss=,comm="], {
      timeoutMs: Math.min(1_000, context.timeoutMs ?? 1_000),
      signal: context.signal,
    })
    if (result.exitCode !== 0 || result.timedOut || result.aborted) return ""
    return formatProcessMemoryContext(parseExcessiveProcessMemory(result.stdout))
  } catch {
    return ""
  }
}

/** Advisory only: unavailable process information must never block a tool. */
export async function evaluateProcessMemoryContext(
  eventName: "PreToolUse" | "PostToolUse",
  context: SwizHookRunContext = {},
  run: typeof spawnWithTimeout = spawnWithTimeout,
  platform = process.platform
): Promise<SwizHookOutput> {
  if (platform !== "darwin" && platform !== "linux") return {}
  if (context.signal?.aborted) return {}
  const message = await readProcessMemoryContext(context, run)
  return message ? buildContextHookOutput(eventName, message, { rephrase: false }) : {}
}
