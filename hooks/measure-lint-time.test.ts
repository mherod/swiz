import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { unlink } from "node:fs/promises"
import { join } from "node:path"
import type { PostToolHookInput, ShellHookInput } from "../src/schemas.ts"
import { TMP_ROOT } from "../src/temp-paths.ts"
import posttooluseMeasureLintTime from "./posttooluse-measure-lint-time.ts"
import pretooluseMeasureLintTime, { isFullLintSuiteRun } from "./pretooluse-measure-lint-time.ts"

const SESSION_ID = "test-session-measure-lint-time"
const SENTINEL_PATH = join(TMP_ROOT, `swiz-lint-start-${SESSION_ID}.json`)
const STATS_PATH = join(process.cwd(), ".swiz", "lint-execution-stats.json")

describe("Measure Lint Time Hooks", () => {
  beforeEach(async () => {
    await unlink(SENTINEL_PATH).catch(() => {})
    await unlink(STATS_PATH).catch(() => {})
  })

  afterEach(async () => {
    await unlink(SENTINEL_PATH).catch(() => {})
    await unlink(STATS_PATH).catch(() => {})
  })

  describe("parseLintCommand & isFullLintSuiteRun", () => {
    test("detects full lint suite runs", () => {
      expect(isFullLintSuiteRun("eslint .")).toBe(true)
      expect(isFullLintSuiteRun("eslint ./")).toBe(true)
      expect(isFullLintSuiteRun("biome check .")).toBe(true)
      expect(isFullLintSuiteRun("biome check ./")).toBe(true)
      expect(isFullLintSuiteRun("biome ci .")).toBe(true)
      expect(isFullLintSuiteRun("bun run lint")).toBe(true)
      expect(isFullLintSuiteRun("npm run lint")).toBe(true)
      expect(isFullLintSuiteRun("pnpm run lint")).toBe(true)
      expect(isFullLintSuiteRun("yarn lint")).toBe(true)
      expect(isFullLintSuiteRun("eslint --format json .")).toBe(true)
      expect(isFullLintSuiteRun("NODE_ENV=production eslint .")).toBe(true)
    })

    test("filters out single file or limited directory lint runs", () => {
      expect(isFullLintSuiteRun("eslint src/command-utils.ts")).toBe(false)
      expect(isFullLintSuiteRun("biome check hooks/")).toBe(false)
      expect(isFullLintSuiteRun("npm run lint -- hooks/")).toBe(false)
      expect(isFullLintSuiteRun("bun run lint hooks/pretooluse-measure-lint-time.ts")).toBe(false)
    })

    test("ignores non-lint commands", () => {
      expect(isFullLintSuiteRun("git status")).toBe(false)
      expect(isFullLintSuiteRun("bun test")).toBe(false)
    })
  })

  describe("End-to-End Flow", () => {
    test("preToolUse writes sentinel and postToolUse computes average", async () => {
      const preInput: ShellHookInput = {
        session_id: SESSION_ID,
        tool_name: "Bash",
        tool_input: {
          command: "eslint .",
        },
        cwd: process.cwd(),
      }

      const preOutput = await pretooluseMeasureLintTime.run(preInput)
      expect(preOutput).toEqual({})

      // Verify sentinel is written
      const sentinelFile = Bun.file(SENTINEL_PATH)
      expect(await sentinelFile.exists()).toBe(true)
      const sentinelData = JSON.parse(await sentinelFile.text())
      expect(sentinelData.command).toBe("eslint .")
      expect(typeof sentinelData.startTime).toBe("number")

      // Fast-forward startTime a bit to simulate elapsed time
      sentinelData.startTime -= 1500 // simulate 1.5 seconds
      await Bun.write(SENTINEL_PATH, JSON.stringify(sentinelData))

      // 2. Run PostToolUse hook
      const postInput: PostToolHookInput = {
        session_id: SESSION_ID,
        tool_name: "Bash",
        tool_input: {
          command: "eslint .",
        },
        cwd: process.cwd(),
      }

      const postOutput = (await posttooluseMeasureLintTime.run(postInput)) as any
      expect(postOutput.systemMessage).toBeDefined()
      expect(postOutput.systemMessage).toContain("Average lint execution time updated")
      expect(postOutput.systemMessage).toContain("(based on 1 runs)")

      // Verify sentinel was cleaned up
      expect(await Bun.file(SENTINEL_PATH).exists()).toBe(false)

      // Verify stats file is written
      const statsFile = Bun.file(STATS_PATH)
      expect(await statsFile.exists()).toBe(true)
      const statsData = JSON.parse(await statsFile.text())
      expect(statsData.count).toBe(1)
      expect(statsData.totalTimeMs).toBeGreaterThanOrEqual(1500)

      // 3. Run again to verify averaging
      await pretooluseMeasureLintTime.run(preInput)
      const sentinelData2 = JSON.parse(await Bun.file(SENTINEL_PATH).text())
      sentinelData2.startTime -= 2500 // simulate 2.5 seconds
      await Bun.write(SENTINEL_PATH, JSON.stringify(sentinelData2))

      const postOutput2 = (await posttooluseMeasureLintTime.run(postInput)) as any
      expect(postOutput2.systemMessage).toContain("based on 2 runs")

      const statsData2 = JSON.parse(await statsFile.text())
      expect(statsData2.count).toBe(2)
      expect(statsData2.totalTimeMs).toBeGreaterThanOrEqual(4000)
      const expectedAverage = statsData2.totalTimeMs / 2 / 1000
      expect(postOutput2.systemMessage).toContain(
        `Average lint execution time updated: ${expectedAverage.toFixed(2)}s`
      )
    })
  })
})
