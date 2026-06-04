/**
 * Shared reader for per-project test/lint execution timing stats.
 *
 * The measure-test-time / measure-lint-time hook pairs accumulate
 * `{ totalTimeMs, count }` into `.swiz/<kind>-execution-stats.json` at the
 * project root. This module is the canonical reader for those files —
 * consumed by `swiz status` and the status line.
 */

import { join } from "node:path"

export type ExecutionStatsKind = "test" | "lint"

export interface ExecutionStatsSummary {
  totalTimeMs: number
  count: number
  averageMs: number
  assessment: "negligible" | "significant"
}

/** Average runtimes at or above this are flagged as "significant". */
export const EXECUTION_STATS_SIGNIFICANT_MS = 5000

export function getExecutionStatsPath(projectRoot: string, kind: ExecutionStatsKind): string {
  return join(projectRoot, ".swiz", `${kind}-execution-stats.json`)
}

async function readStatsFile(
  statsPath: string
): Promise<{ totalTimeMs: number; count: number } | null> {
  const file = Bun.file(statsPath)
  if (!(await file.exists())) return null
  try {
    const raw = await file.text()
    const parsed = JSON.parse(raw)
    if (
      typeof parsed.totalTimeMs === "number" &&
      typeof parsed.count === "number" &&
      parsed.count > 0
    ) {
      return { totalTimeMs: parsed.totalTimeMs, count: parsed.count }
    }
  } catch {}
  return null
}

function summarize(
  data: { totalTimeMs: number; count: number } | null
): ExecutionStatsSummary | null {
  if (!data) return null
  const averageMs = data.totalTimeMs / data.count
  return {
    totalTimeMs: data.totalTimeMs,
    count: data.count,
    averageMs,
    assessment: averageMs < EXECUTION_STATS_SIGNIFICANT_MS ? "negligible" : "significant",
  }
}

export async function readExecutionStats(
  projectRoot: string,
  kind: ExecutionStatsKind
): Promise<ExecutionStatsSummary | null> {
  return summarize(await readStatsFile(getExecutionStatsPath(projectRoot, kind)))
}

export interface ProjectExecutionStats {
  test: ExecutionStatsSummary | null
  lint: ExecutionStatsSummary | null
}

/** Read both test and lint execution stats for a project root. */
export async function readProjectExecutionStats(
  projectRoot: string
): Promise<ProjectExecutionStats | null> {
  const [test, lint] = await Promise.all([
    readExecutionStats(projectRoot, "test"),
    readExecutionStats(projectRoot, "lint"),
  ])
  if (!test && !lint) return null
  return { test, lint }
}
