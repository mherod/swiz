import { afterAll, describe, expect, test } from "bun:test"
import { join } from "node:path"
import type { PostToolHookInput } from "../src/schemas.ts"
import { TMP_ROOT } from "../src/temp-paths.ts"
import { getExecutionStatsPath } from "../src/utils/execution-stats.ts"
import { useTempDir } from "../src/utils/test-utils.ts"
import {
  type ExecutionMeasurement,
  evaluateCompletedMeasurement,
} from "./measure-execution-time.ts"

const { create } = useTempDir("swiz-shell-timing-")
const sentinels: string[] = []
const outcomeCases: Array<{
  response: PostToolHookInput["tool_response"]
  outcome: "failed" | "unknown"
}> = [
  { response: { exitCode: 1 }, outcome: "failed" },
  { response: { exit_code: 2 }, outcome: "failed" },
  { response: { stdout: "passed" }, outcome: "unknown" },
  { response: "Process exited with code 0", outcome: "unknown" },
  { response: undefined, outcome: "unknown" },
  { response: { exit_code: null }, outcome: "unknown" },
]

afterAll(async () => {
  await Promise.all(
    sentinels.map((path) =>
      Bun.file(path)
        .delete()
        .catch(() => {})
    )
  )
})

async function measurementFixture(kind: ExecutionMeasurement["kind"] = "lint") {
  const cwd = await create()
  const sessionId = `shell-timing-${crypto.randomUUID()}`
  const sentinelPath = join(TMP_ROOT, `swiz-${kind}-start-${sessionId}.json`)
  sentinels.push(sentinelPath)
  await Bun.write(sentinelPath, JSON.stringify({ startTime: Date.now() - 250 }))
  const input: PostToolHookInput = {
    session_id: sessionId,
    tool_name: "Bash",
    tool_input: { command: `bun run ${kind}` },
    cwd,
  }
  return { input, sentinelPath, statsPath: getExecutionStatsPath(cwd, kind) }
}

describe("shared shell timing recorder", () => {
  test.each([
    { kind: "lint", label: "Lint" },
    { kind: "test", label: "Test" },
  ] as const)("records $kind metadata and preserves legacy totals", async (measurement) => {
    const { input, sentinelPath, statsPath } = await measurementFixture(measurement.kind)
    await Bun.write(statsPath, JSON.stringify({ totalTimeMs: 100, count: 2 }))
    const before = Date.now()
    const result = await evaluateCompletedMeasurement(
      { ...input, tool_response: { exit_code: 0 } },
      measurement
    )
    const stats = await Bun.file(statsPath).json()
    expect(stats.count).toBe(3)
    expect(stats.totalTimeMs).toBeGreaterThanOrEqual(350)
    expect(stats.recentRuns).toHaveLength(1)
    expect(stats.recentRuns[0]).toMatchObject({ source: "shell-tool", outcome: "passed" })
    expect(stats.recentRuns[0].durationMs).toBeGreaterThanOrEqual(250)
    expect(stats.recentRuns[0].recordedAt).toBeGreaterThanOrEqual(before)
    expect(stats.recentRuns[0].recordedAt).toBeLessThanOrEqual(Date.now())
    expect("systemMessage" in result && result.systemMessage).toContain("based on 3 runs")
    expect(await Bun.file(sentinelPath).exists()).toBe(false)
  })

  test.each(outcomeCases)("records $outcome from structured completion evidence", async ({
    response,
    outcome,
  }) => {
    const { input, statsPath } = await measurementFixture()
    await evaluateCompletedMeasurement(
      { ...input, tool_response: response },
      { kind: "lint", label: "Lint" }
    )
    const stats = await Bun.file(statsPath).json()
    expect(stats.recentRuns[0].outcome).toBe(outcome)
  })

  test("keeps telemetry write failures non-blocking", async () => {
    const { input, sentinelPath } = await measurementFixture()
    await Bun.write(join(input.cwd!, ".swiz"), "not a directory")
    expect(await evaluateCompletedMeasurement(input, { kind: "lint", label: "Lint" })).toEqual({})
    expect(await Bun.file(sentinelPath).exists()).toBe(false)
  })

  test("does not record a background launch as a completed run", async () => {
    const { input, sentinelPath, statsPath } = await measurementFixture()
    const result = await evaluateCompletedMeasurement(
      { ...input, tool_input: { ...input.tool_input, run_in_background: true } },
      { kind: "lint", label: "Lint" }
    )
    expect(result).toEqual({})
    expect(await Bun.file(statsPath).exists()).toBe(false)
    expect(await Bun.file(sentinelPath).exists()).toBe(true)
  })
})
