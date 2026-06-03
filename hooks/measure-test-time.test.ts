import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { unlink } from "node:fs/promises"
import { join } from "node:path"
import type { PostToolHookInput, ShellHookInput } from "../src/schemas.ts"
import { TMP_ROOT } from "../src/temp-paths.ts"
import posttooluseMeasureTestTime from "./posttooluse-measure-test-time.ts"
import pretooluseMeasureTestTime, { isFullTestSuiteRun } from "./pretooluse-measure-test-time.ts"

const SESSION_ID = "test-session-measure-time"
const SENTINEL_PATH = join(TMP_ROOT, `swiz-test-start-${SESSION_ID}.json`)
const STATS_PATH = join(process.cwd(), ".swiz", "test-execution-stats.json")

describe("Measure Test Time Hooks", () => {
  beforeEach(async () => {
    await unlink(SENTINEL_PATH).catch(() => {})
    await unlink(STATS_PATH).catch(() => {})
  })

  afterEach(async () => {
    await unlink(SENTINEL_PATH).catch(() => {})
    await unlink(STATS_PATH).catch(() => {})
  })

  describe("parseTestCommand & isFullTestSuiteRun", () => {
    test("detects full test suite runs", () => {
      expect(isFullTestSuiteRun("bun test")).toBe(true)
      expect(isFullTestSuiteRun("bun test --concurrent")).toBe(true)
      expect(isFullTestSuiteRun("bun test --timeout 5000")).toBe(true)
      expect(isFullTestSuiteRun("bun run test")).toBe(true)
      expect(isFullTestSuiteRun("npm test")).toBe(true)
      expect(isFullTestSuiteRun("npm run test")).toBe(true)
      expect(isFullTestSuiteRun("pnpm test")).toBe(true)
      expect(isFullTestSuiteRun("pnpm run test")).toBe(true)
      expect(isFullTestSuiteRun("yarn test")).toBe(true)
      expect(isFullTestSuiteRun("vitest")).toBe(true)
      expect(isFullTestSuiteRun("vitest run")).toBe(true)
      expect(isFullTestSuiteRun("vitest --config vite.config.ts")).toBe(true)
      expect(isFullTestSuiteRun("NODE_ENV=test bun test")).toBe(true)
      expect(isFullTestSuiteRun("bun test .")).toBe(true)
      expect(isFullTestSuiteRun("bun test ./")).toBe(true)
    })

    test("filters out single file or limited directory test runs", () => {
      // Single files
      expect(isFullTestSuiteRun("bun test hooks/some-file.test.ts")).toBe(false)
      expect(isFullTestSuiteRun("bun test src/dispatch.test.ts")).toBe(false)
      expect(isFullTestSuiteRun("vitest src/dispatch-routing.test.ts")).toBe(false)
      expect(isFullTestSuiteRun("npm test -- src/dispatch.test.ts")).toBe(false)

      // Subdirectories / limited runs
      expect(isFullTestSuiteRun("bun test hooks/")).toBe(false)
      expect(isFullTestSuiteRun("bun test src/")).toBe(false)
      expect(isFullTestSuiteRun("vitest run src/utils")).toBe(false)
      expect(isFullTestSuiteRun("pnpm test hooks")).toBe(false)
    })

    test("ignores non-test commands", () => {
      expect(isFullTestSuiteRun("git status")).toBe(false)
      expect(isFullTestSuiteRun("bun run index.ts")).toBe(false)
      expect(isFullTestSuiteRun("echo 'bun test'")).toBe(false)
    })
  })

  describe("End-to-End Flow", () => {
    test("preToolUse writes sentinel and postToolUse computes average", async () => {
      // 1. Run PreToolUse hook
      const preInput: ShellHookInput = {
        session_id: SESSION_ID,
        tool_name: "Bash",
        tool_input: {
          command: "bun test --concurrent",
        },
        cwd: process.cwd(),
      }

      const preOutput = await pretooluseMeasureTestTime.run(preInput)
      expect(preOutput).toEqual({})

      // Verify sentinel is written
      const sentinelFile = Bun.file(SENTINEL_PATH)
      expect(await sentinelFile.exists()).toBe(true)
      const sentinelData = JSON.parse(await sentinelFile.text())
      expect(sentinelData.command).toBe("bun test --concurrent")
      expect(typeof sentinelData.startTime).toBe("number")

      // Fast-forward startTime a bit to simulate elapsed time
      sentinelData.startTime -= 2000 // simulate 2 seconds
      await Bun.write(SENTINEL_PATH, JSON.stringify(sentinelData))

      // 2. Run PostToolUse hook
      const postInput: PostToolHookInput = {
        session_id: SESSION_ID,
        tool_name: "Bash",
        tool_input: {
          command: "bun test --concurrent",
        },
        cwd: process.cwd(),
      }

      const postOutput = (await posttooluseMeasureTestTime.run(postInput)) as any
      expect(postOutput.systemMessage).toBeDefined()
      expect(postOutput.systemMessage).toContain("Average test execution time updated")
      expect(postOutput.systemMessage).toContain("(based on 1 runs)")

      // Verify sentinel was cleaned up
      expect(await Bun.file(SENTINEL_PATH).exists()).toBe(false)

      // Verify stats file is written
      const statsFile = Bun.file(STATS_PATH)
      expect(await statsFile.exists()).toBe(true)
      const statsData = JSON.parse(await statsFile.text())
      expect(statsData.count).toBe(1)
      expect(statsData.totalTimeMs).toBeGreaterThanOrEqual(2000)

      // 3. Run again to verify averaging
      await pretooluseMeasureTestTime.run(preInput)
      const sentinelData2 = JSON.parse(await sentinelFile.text())
      sentinelData2.startTime -= 4000 // simulate 4 seconds
      await Bun.write(SENTINEL_PATH, JSON.stringify(sentinelData2))

      const postOutput2 = (await posttooluseMeasureTestTime.run(postInput)) as any
      expect(postOutput2.systemMessage).toContain("based on 2 runs")

      const statsData2 = JSON.parse(await statsFile.text())
      expect(statsData2.count).toBe(2)
      // totalTime should be around 6000ms
      expect(statsData2.totalTimeMs).toBeGreaterThanOrEqual(6000)
      const expectedAverage = statsData2.totalTimeMs / 2 / 1000
      expect(postOutput2.systemMessage).toContain(
        `Average test execution time updated: ${expectedAverage.toFixed(2)}s`
      )
    })

    test("does not track time if preToolUse did not match", async () => {
      const preInput: ShellHookInput = {
        session_id: SESSION_ID,
        tool_name: "Bash",
        tool_input: {
          command: "bun test hooks/pretooluse-bun-test-concurrent.test.ts",
        },
        cwd: process.cwd(),
      }

      await pretooluseMeasureTestTime.run(preInput)
      expect(await Bun.file(SENTINEL_PATH).exists()).toBe(false)

      const postInput: PostToolHookInput = {
        session_id: SESSION_ID,
        tool_name: "Bash",
        tool_input: {
          command: "bun test hooks/pretooluse-bun-test-concurrent.test.ts",
        },
        cwd: process.cwd(),
      }

      const postOutput = await posttooluseMeasureTestTime.run(postInput)
      expect(postOutput).toEqual({})
    })
  })
})
