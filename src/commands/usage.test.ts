import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { buildUsageReport, parseUsageArgs, usageCommand } from "./usage.ts"

const tempDirs: string[] = []

const FIXTURE = {
  numStartups: 12,
  installMethod: "native",
  autoUpdates: false,
  promptQueueUseCount: 27,
  mcpServers: {
    figma: { type: "http", url: "https://mcp.figma.com/mcp" },
  },
  skillUsage: {
    commit: { usageCount: 20 },
    push: { usageCount: 12 },
    updateMemory: { usageCount: 3 },
  },
  projects: {
    "/Users/test/swiz": {
      lastCost: 14.5,
      lastTotalInputTokens: 120,
      lastTotalOutputTokens: 960,
      lastTotalCacheReadInputTokens: 3840,
      lastTotalCacheCreationInputTokens: 200,
      lastModelUsage: {
        "claude-sonnet-4-6": {
          inputTokens: 120,
          outputTokens: 960,
          cacheReadInputTokens: 3840,
          cacheCreationInputTokens: 200,
          costUSD: 14.5,
        },
      },
    },
    "/Users/test/skills": {
      lastCost: 2,
      lastTotalInputTokens: 80,
      lastTotalOutputTokens: 320,
      lastTotalCacheReadInputTokens: 800,
      lastTotalCacheCreationInputTokens: 40,
      lastModelUsage: {
        "claude-haiku-4-5-20251001": {
          inputTokens: 80,
          outputTokens: 320,
          cacheReadInputTokens: 800,
          cacheCreationInputTokens: 40,
          costUSD: 2,
        },
      },
    },
  },
}

async function makeTempDir(prefix = "swiz-usage-test-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (!dir) continue
    await rm(dir, { recursive: true, force: true })
  }
})

describe("parseUsageArgs", () => {
  it("uses defaults", () => {
    expect(parseUsageArgs([])).toEqual({
      filePath: undefined,
      asJson: false,
      top: 10,
    })
  })

  it("parses file, top, and json flags", () => {
    expect(parseUsageArgs(["--file", "/tmp/usage.json", "--top", "5", "--json"])).toEqual({
      filePath: "/tmp/usage.json",
      asJson: true,
      top: 5,
    })
  })

  it("throws on unknown args", () => {
    expect(() => parseUsageArgs(["--wat"])).toThrow("Unknown argument")
  })
})

describe("buildUsageReport", () => {
  it("computes top rankings and totals", () => {
    const report = buildUsageReport(FIXTURE, "/tmp/.claude.json", 2)

    expect(report.topSkills.map((s) => s.name)).toEqual(["commit", "push"])
    expect(report.topProjectsByCost.map((p) => p.name)).toEqual(["swiz", "skills"])
    expect(report.modelUsage.map((m) => m.model)).toEqual([
      "claude-sonnet-4-6",
      "claude-haiku-4-5-20251001",
    ])

    expect(report.totals.input).toBe(200)
    expect(report.totals.output).toBe(1280)
    expect(report.totals.cacheRead).toBe(4640)
    expect(report.totals.cost).toBe(16.5)
    expect(report.totals.outputToInputRatio).toBeCloseTo(6.4)
    expect(report.totals.cacheReadToInputRatio).toBeCloseTo(23.2)
  })
})

describe("usageCommand", () => {
  let logOutput: string[]

  beforeEach(() => {
    logOutput = []
    vi.spyOn(console, "log").mockImplementation((...args) => {
      logOutput.push(args.join(" "))
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("prints a human-readable summary", async () => {
    const dir = await makeTempDir()
    const filePath = join(dir, ".claude.json")
    await writeFile(filePath, JSON.stringify(FIXTURE))

    await usageCommand.run(["--file", filePath, "--top", "2"])

    const output = logOutput.join("\n")
    expect(output).toContain("swiz usage")
    expect(output).toContain("Top Skills")
    expect(output).toContain("Model Usage")
    expect(output).toContain("Totals")
  })

  it("prints JSON when --json is passed", async () => {
    const dir = await makeTempDir()
    const filePath = join(dir, ".claude.json")
    await writeFile(filePath, JSON.stringify(FIXTURE))

    await usageCommand.run(["--file", filePath, "--json"])

    expect(logOutput.length).toBe(1)
    const parsed = JSON.parse(logOutput[0] ?? "{}") as {
      projectCount?: number
      topSkills?: unknown[]
    }
    expect(parsed.projectCount).toBe(2)
    expect(Array.isArray(parsed.topSkills)).toBe(true)
  })

  it("throws when file does not exist", async () => {
    const dir = await makeTempDir()
    const filePath = join(dir, "missing.json")

    await expect(usageCommand.run(["--file", filePath])).rejects.toThrow("not found")
  })
})
