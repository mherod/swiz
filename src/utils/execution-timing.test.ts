import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { getExecutionStatsPath, readExecutionStatsData } from "./execution-stats.ts"
import { EXECUTION_TIMING_HISTORY_LIMIT, recordExecutionDuration } from "./execution-timing.ts"
import { neutralAgentEnv, useTempDir } from "./test-utils.ts"

const { create } = useTempDir("swiz-execution-timing-")

describe("recordExecutionDuration", () => {
  test("preserves legacy totals and distinguishes sources and outcomes", async () => {
    const cwd = await create()
    await Bun.write(
      getExecutionStatsPath(cwd, "lint"),
      JSON.stringify({ totalTimeMs: 500, count: 2 })
    )
    await recordExecutionDuration({
      cwd,
      kind: "lint",
      durationMs: 100,
      source: "shell-tool",
      outcome: "unknown",
    })
    const summary = await recordExecutionDuration({
      cwd,
      kind: "lint",
      durationMs: 200,
      source: "stop-hook",
      outcome: "failed",
    })
    expect(summary).toMatchObject({ totalTimeMs: 800, count: 4, averageMs: 200 })
    const data = await readExecutionStatsData(cwd, "lint")
    expect(data?.recentRuns).toEqual([
      { durationMs: 100, source: "shell-tool", outcome: "unknown", recordedAt: expect.any(Number) },
      { durationMs: 200, source: "stop-hook", outcome: "failed", recordedAt: expect.any(Number) },
    ])
  })

  test("bounds history while preserving lifetime totals", async () => {
    const cwd = await create()
    for (let index = 0; index < EXECUTION_TIMING_HISTORY_LIMIT + 2; index++) {
      await recordExecutionDuration({
        cwd,
        kind: "typecheck",
        durationMs: index,
        source: "stop-hook",
        outcome: "passed",
      })
    }
    const data = await readExecutionStatsData(cwd, "typecheck")
    expect(data?.count).toBe(EXECUTION_TIMING_HISTORY_LIMIT + 2)
    expect(data?.recentRuns).toHaveLength(EXECUTION_TIMING_HISTORY_LIMIT)
    expect(data?.recentRuns[0]?.durationMs).toBe(2)
    expect(data?.recentRuns.at(-1)?.durationMs).toBe(EXECUTION_TIMING_HISTORY_LIMIT + 1)
  })

  test("retains every update from concurrent processes", async () => {
    const cwd = await create()
    const modulePath = join(import.meta.dir, "execution-timing.ts")
    const code = `
      import { recordExecutionDuration } from ${JSON.stringify(modulePath)};
      for (let i = 0; i < 3; i++) {
        const result = await recordExecutionDuration({
          cwd: process.cwd(), kind: 'test', durationMs: 25,
          source: 'shell-tool', outcome: 'passed'
        });
        if (!result) throw new Error('Timing record was not saved');
      }
    `
    const processes = Array.from({ length: 4 }, () =>
      Bun.spawn([process.execPath, "--eval", code], {
        cwd,
        env: neutralAgentEnv({ HOME: cwd, AI_TEST_NO_BACKEND: "1" }),
        stdout: "pipe",
        stderr: "pipe",
      })
    )
    const results = await Promise.all(
      processes.map(async (proc) => {
        const [stdout, stderr] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ])
        return { exitCode: await proc.exited, stdout, stderr }
      })
    )
    for (const result of results) expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" })
    const data = await readExecutionStatsData(cwd, "test")
    expect(data).toMatchObject({ totalTimeMs: 300, count: 12 })
    expect(data?.recentRuns).toHaveLength(12)
  }, 10_000)

  test("ignores invalid durations without writing misleading samples", async () => {
    const cwd = await create()
    for (const durationMs of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        await recordExecutionDuration({
          cwd,
          kind: "lint",
          durationMs,
          source: "shell-tool",
          outcome: "unknown",
        })
      ).toBeNull()
    }
    expect(await readExecutionStatsData(cwd, "lint")).toBeNull()
  })

  test("returns null when telemetry storage is unavailable", async () => {
    const cwd = await create()
    await Bun.write(join(cwd, ".swiz"), "not a directory")
    expect(
      await recordExecutionDuration({
        cwd,
        kind: "test",
        durationMs: 10,
        source: "shell-tool",
        outcome: "passed",
      })
    ).toBeNull()
  })
})
