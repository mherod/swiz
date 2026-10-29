import { join } from "node:path"
import type { SwizHookOutput } from "../src/SwizHook.ts"
import type { PostToolHookInput } from "../src/schemas.ts"
import { resolveSafeSessionId } from "../src/session-id.ts"
import { TMP_ROOT } from "../src/temp-paths.ts"
import { isShellTool } from "../src/tool-matchers.ts"
import { recordExecutionDuration } from "../src/utils/execution-timing.ts"
import { isBackgroundCommand } from "../src/utils/inline-hook-helpers.ts"

export interface ExecutionMeasurement {
  kind: "lint" | "test"
  label: "Lint" | "Test"
}

async function consumeStartTime(sentinelPath: string): Promise<number | null> {
  const file = Bun.file(sentinelPath)
  if (!(await file.exists())) return null

  const data: unknown = JSON.parse(await file.text())
  await file.delete().catch(() => {})
  return typeof data === "object" && data !== null && "startTime" in data
    ? typeof data.startTime === "number"
      ? data.startTime
      : null
    : null
}

function shellOutcome(input: PostToolHookInput): "passed" | "failed" | "unknown" {
  const response = input.tool_response
  if (!response || typeof response !== "object" || Array.isArray(response)) return "unknown"
  const exitCode = response.exit_code ?? response.exitCode
  if (typeof exitCode !== "number" || !Number.isInteger(exitCode)) return "unknown"
  return exitCode === 0 ? "passed" : "failed"
}

function isForegroundShellTool(input: PostToolHookInput): boolean {
  if (!input.tool_name || !isShellTool(input.tool_name)) return false
  const command = String(input.tool_input?.command ?? "")
  return !isBackgroundCommand(input, command)
}

export async function evaluateCompletedMeasurement(
  input: PostToolHookInput,
  measurement: ExecutionMeasurement
): Promise<SwizHookOutput> {
  if (!isForegroundShellTool(input)) return {}

  const sessionId = resolveSafeSessionId(input.session_id) || "default"
  const sentinelPath = join(TMP_ROOT, `swiz-${measurement.kind}-start-${sessionId}.json`)

  try {
    const startTime = await consumeStartTime(sentinelPath)
    if (startTime === null) return {}

    const elapsedMs = Date.now() - startTime
    const stats = await recordExecutionDuration({
      cwd: input.cwd ?? process.cwd(),
      kind: measurement.kind,
      durationMs: elapsedMs,
      source: "shell-tool",
      outcome: shellOutcome(input),
    })
    if (!stats) return {}
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
