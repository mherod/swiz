/**
 * Shared reader for per-project test/lint/typecheck execution timing stats.
 *
 * Shell-tool hooks and stop-hook subprocesses share the recorder in
 * execution-timing.ts. Legacy totals remain readable alongside recent samples.
 */

import { join } from "node:path"
import { z } from "zod"

export type ExecutionStatsKind = "test" | "lint" | "typecheck"

const executionRunSchema = z.object({
  durationMs: z.number().nonnegative(),
  source: z.enum(["shell-tool", "stop-hook"]),
  outcome: z.enum(["passed", "failed", "timeout", "unavailable", "unknown"]),
  recordedAt: z.number().nonnegative(),
})

const executionStatsDataSchema = z.object({
  totalTimeMs: z.number().nonnegative(),
  count: z.number().int().nonnegative(),
  recentRuns: z.array(executionRunSchema).catch([]).default([]),
})

export type ExecutionRun = z.infer<typeof executionRunSchema>
export type ExecutionStatsData = z.infer<typeof executionStatsDataSchema>

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

export async function readExecutionStatsData(
  projectRoot: string,
  kind: ExecutionStatsKind
): Promise<ExecutionStatsData | null> {
  try {
    const raw = await Bun.file(getExecutionStatsPath(projectRoot, kind)).json()
    const parsed = executionStatsDataSchema.safeParse(raw)
    if (parsed.success) return parsed.data
  } catch {}
  return null
}

export function summarizeExecutionStats(
  data: { totalTimeMs: number; count: number } | null
): ExecutionStatsSummary | null {
  if (!data || data.count === 0) return null
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
  return summarizeExecutionStats(await readExecutionStatsData(projectRoot, kind))
}

export interface ProjectExecutionStats {
  test: ExecutionStatsSummary | null
  lint: ExecutionStatsSummary | null
  typecheck: ExecutionStatsSummary | null
}

/** Read test, lint and typecheck execution stats for a project root. */
export async function readProjectExecutionStats(
  projectRoot: string
): Promise<ProjectExecutionStats | null> {
  const [test, lint, typecheck] = await Promise.all([
    readExecutionStats(projectRoot, "test"),
    readExecutionStats(projectRoot, "lint"),
    readExecutionStats(projectRoot, "typecheck"),
  ])
  if (!test && !lint && !typecheck) return null
  return { test, lint, typecheck }
}
