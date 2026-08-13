import { unlink } from "node:fs/promises"
import { join } from "node:path"
import { git } from "../src/git-helpers.ts"
import type { SwizHookOutput } from "../src/SwizHook.ts"
import type { PostToolHookInput } from "../src/schemas.ts"
import { resolveSafeSessionId } from "../src/session-id.ts"
import { TMP_ROOT } from "../src/temp-paths.ts"
import { isShellTool } from "../src/tool-matchers.ts"
import { isBackgroundCommand } from "../src/utils/inline-hook-helpers.ts"

interface ExecutionStats {
  totalTimeMs: number
  count: number
}

export interface ExecutionMeasurement {
  kind: "lint" | "test"
  label: "Lint" | "Test"
}

function isExecutionStats(value: unknown): value is ExecutionStats {
  return (
    typeof value === "object" &&
    value !== null &&
    "totalTimeMs" in value &&
    typeof value.totalTimeMs === "number" &&
    "count" in value &&
    typeof value.count === "number"
  )
}

async function consumeStartTime(sentinelPath: string): Promise<number | null> {
  const file = Bun.file(sentinelPath)
  if (!(await file.exists())) return null

  const data: unknown = JSON.parse(await file.text())
  await unlink(sentinelPath).catch(() => {})
  return typeof data === "object" && data !== null && "startTime" in data
    ? typeof data.startTime === "number"
      ? data.startTime
      : null
    : null
}

async function readExecutionStats(statsPath: string): Promise<ExecutionStats> {
  const statsFile = Bun.file(statsPath)
  if (!(await statsFile.exists())) return { totalTimeMs: 0, count: 0 }

  try {
    const existing: unknown = JSON.parse(await statsFile.text())
    return isExecutionStats(existing) ? existing : { totalTimeMs: 0, count: 0 }
  } catch {
    return { totalTimeMs: 0, count: 0 }
  }
}

async function recordExecutionDuration(
  input: PostToolHookInput,
  elapsedMs: number,
  kind: ExecutionMeasurement["kind"]
): Promise<ExecutionStats> {
  const cwd = input.cwd ?? process.cwd()
  const repoRoot = await git(["rev-parse", "--show-toplevel"], cwd)
  const statsPath = join(repoRoot || cwd, ".swiz", `${kind}-execution-stats.json`)
  const stats = await readExecutionStats(statsPath)

  stats.totalTimeMs += elapsedMs
  stats.count += 1
  await Bun.write(statsPath, JSON.stringify(stats, null, 2))
  return stats
}

export async function evaluateCompletedMeasurement(
  input: PostToolHookInput,
  measurement: ExecutionMeasurement
): Promise<SwizHookOutput> {
  if (!input.tool_name || !isShellTool(input.tool_name)) return {}

  const command = String(input.tool_input?.command ?? "")
  if (isBackgroundCommand(input, command)) return {}

  const sessionId = resolveSafeSessionId(input.session_id) || "default"
  const sentinelPath = join(TMP_ROOT, `swiz-${measurement.kind}-start-${sessionId}.json`)

  try {
    const startTime = await consumeStartTime(sentinelPath)
    if (startTime === null) return {}

    const elapsedMs = Date.now() - startTime
    const stats = await recordExecutionDuration(input, elapsedMs, measurement.kind)
    const averageSeconds = stats.totalTimeMs / stats.count / 1000
    const currentSeconds = elapsedMs / 1000
    return {
      systemMessage: `${measurement.label} run took ${currentSeconds.toFixed(2)}s. Average ${measurement.kind} execution time updated: ${averageSeconds.toFixed(2)}s (based on ${stats.count} runs).`,
    }
  } catch {
    // Non-fatal
    return {}
  }
}
