/** Shared, best-effort timing recorder for shell tools and quality-check subprocesses. */
import { realpath } from "node:fs/promises"
import { git } from "../git-helpers.ts"
import {
  type ExecutionRun,
  type ExecutionStatsKind,
  type ExecutionStatsSummary,
  getExecutionStatsPath,
  readExecutionStatsData,
  summarizeExecutionStats,
} from "./execution-stats.ts"
import { getLockPathForFile, withFileLock } from "./file-lock.ts"
import { writeJsonlTextAtomically } from "./jsonl.ts"

export const EXECUTION_TIMING_HISTORY_LIMIT = 50

export interface ExecutionTimingInput {
  cwd: string
  kind: ExecutionStatsKind
  durationMs: number
  source: ExecutionRun["source"]
  outcome: ExecutionRun["outcome"]
}

/** Timing failures must never change the result of the check being measured. */
export async function recordExecutionDuration(
  input: ExecutionTimingInput
): Promise<ExecutionStatsSummary | null> {
  if (!Number.isFinite(input.durationMs) || input.durationMs < 0) return null
  const recordedAt = Date.now()
  try {
    const repoRoot = await git(["rev-parse", "--show-toplevel"], input.cwd)
    const projectRoot = await realpath(repoRoot || input.cwd)
    const statsPath = getExecutionStatsPath(projectRoot, input.kind)
    return await withFileLock(
      getLockPathForFile(statsPath),
      async () => {
        const previous = (await readExecutionStatsData(projectRoot, input.kind)) ?? {
          totalTimeMs: 0,
          count: 0,
          recentRuns: [],
        }
        const sample: ExecutionRun = {
          durationMs: input.durationMs,
          source: input.source,
          outcome: input.outcome,
          recordedAt,
        }
        const stats = {
          totalTimeMs: previous.totalTimeMs + input.durationMs,
          count: previous.count + 1,
          recentRuns: [...previous.recentRuns, sample].slice(-EXECUTION_TIMING_HISTORY_LIMIT),
        }
        await writeJsonlTextAtomically(statsPath, JSON.stringify(stats, null, 2))
        return summarizeExecutionStats(stats)
      },
      // Stop checks already reserve time for process cleanup; telemetry must yield promptly.
      input.source === "stop-hook" ? 250 : 2_000
    )
  } catch {
    return null
  }
}
