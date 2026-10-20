import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { useTempDir } from "../utils/test-utils.ts"
import { formatComplianceReport, parseComplianceArgs } from "./compliance.ts"

const tmp = useTempDir("swiz-compliance-")
const indexPath = join(import.meta.dir, "../../index.ts")

describe("compliance arguments", () => {
  test("defaults to both scenarios with a one-minute limit", () => {
    expect(parseComplianceArgs([])).toEqual({ timeoutMs: 60_000, json: false, list: false })
  })

  test("supports equals and separate values", () => {
    expect(
      parseComplianceArgs([
        "--agent=claude",
        "--scenario",
        "stop",
        "--model=sonnet",
        "--timeout",
        "90",
        "--json",
      ])
    ).toEqual({
      scenario: "stop",
      model: "sonnet",
      timeoutMs: 90_000,
      json: true,
      list: false,
    })
  })

  for (const args of [
    ["--agent", "codex"],
    ["--scenario", "invalid"],
    ["--timeout", "0"],
    ["--timeout", "301"],
    ["--timeout", "1.5"],
    ["--timeout", "Infinity"],
    ["--model"],
    ["--model="],
    ["--model", "--json"],
    ["unexpected"],
  ]) {
    test(`rejects invalid arguments ${args.join(" ")}`, () => {
      expect(() => parseComplianceArgs(args)).toThrow()
    })
  }

  test("human output includes the scope and precise verdict", () => {
    expect(
      formatComplianceReport({
        agent: "claude",
        scope: "Controlled tests only",
        status: "fail",
        results: [
          {
            scenario: "stop",
            status: "fail",
            detail: "Missing receipt",
            events: [],
            durationMs: 0,
          },
        ],
      })
    ).toContain("FAIL stop: Missing receipt")
  })
})

// PROCESS_CONTRACT_TEST: verifies entrypoint registration, JSON stdout and nonzero inconclusive exit.
describe("compliance CLI", () => {
  async function run(...args: string[]) {
    const cwd = await tmp.create()
    const process = Bun.spawn(["bun", indexPath, "compliance", ...args], {
      cwd,
      env: { ...globalThis.process.env, HOME: cwd, SWIZ_DIRECT: "1", AI_TEST_NO_BACKEND: "1" },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ])
    return { stdout, stderr, exitCode: await process.exited }
  }

  test("lists scenarios as JSON without a backend", async () => {
    const result = await run("--list", "--json")
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    expect(JSON.parse(result.stdout).scenarios.map((item: { id: string }) => item.id)).toEqual([
      "stop",
      "pre-tool-use",
    ])
  })

  test("prints help for the registered command", async () => {
    const result = await run("--help")
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("--scenario")
  })

  test("inconclusive backend results exit nonzero with machine-readable evidence", async () => {
    const result = await run("--scenario=stop", "--json")
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toBe("")
    const report = JSON.parse(result.stdout)
    expect(report.status).toBe("inconclusive")
    expect(report.results).toHaveLength(1)
    expect(report.results[0].events).toEqual([])
    expect(report.results[0].detail).toContain("AI_TEST_NO_BACKEND")
  })
})
