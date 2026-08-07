#!/usr/bin/env bun

import { join } from "node:path"
import { getDaemonPort } from "../src/commands/daemon/daemon-admin.ts"
import { createMetrics, recordDispatch } from "../src/commands/daemon/runtime-cache.ts"

const MINIMUM_ITERATIONS = 200
const WARMUP_ITERATIONS = 5
const TOOLS = ["Read", "Bash", "Edit"] as const

type ToolName = (typeof TOOLS)[number]
type BenchmarkRoute = "cold-cli" | "warm-daemon"

interface Sample {
  durationMs: number
  decision: string
  rssBytes: number
}

interface BenchmarkStats {
  route: BenchmarkRoute | "instrumentation"
  tool?: ToolName
  samples: number
  p50Ms: number
  p95Ms: number
  p99Ms: number
  minMs: number
  maxMs: number
  rssBytes: number
  decisionSha256?: string
}

function numberArgument(name: string, fallback: number): number {
  const index = process.argv.indexOf(name)
  if (index < 0) return fallback
  const value = Number(process.argv[index + 1])
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`)
  return value
}

function stringArgument(name: string): string | null {
  const index = process.argv.indexOf(name)
  if (index < 0) return null
  const value = process.argv[index + 1]
  if (!value) throw new Error(`${name} requires a value`)
  return value
}

function selectedTools(): ToolName[] {
  const requested = stringArgument("--tool")
  if (!requested) return [...TOOLS]
  const tool = TOOLS.find((candidate) => candidate.toLowerCase() === requested.toLowerCase())
  if (!tool) throw new Error(`--tool must be one of ${TOOLS.join(", ")}`)
  return [tool]
}

function selectedRoutes(): BenchmarkRoute[] {
  const requested = stringArgument("--route")
  if (!requested || requested === "all") return ["cold-cli", "warm-daemon"]
  if (requested === "cold" || requested === "cold-cli") return ["cold-cli"]
  if (requested === "warm" || requested === "warm-daemon") return ["warm-daemon"]
  throw new Error("--route must be cold, warm, or all")
}

function percentile(sorted: number[], fraction: number): number {
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)
  return sorted[index] ?? 0
}

function round(value: number): number {
  return Number(value.toFixed(2))
}

function decisionSignature(body: string): string {
  const trimmed = body.trim()
  const lastLine = trimmed.split("\n").at(-1) ?? "{}"
  const value = JSON.parse(lastLine) as Record<string, any>
  if (typeof value.error === "string" && value.error) return `error:${value.error}`
  const permissionDecision = value.hookSpecificOutput?.permissionDecision
  if (value.decision === "block" || value.decision === "deny" || permissionDecision === "deny") {
    return "block"
  }
  if (value.continue === false) return "block"
  return "allow"
}

function summarize(
  route: BenchmarkStats["route"],
  samples: Sample[],
  tool?: ToolName
): BenchmarkStats {
  const durations = samples.map((sample) => sample.durationMs).sort((a, b) => a - b)
  const decisions = new Set(samples.map((sample) => sample.decision))
  if (decisions.size !== 1) throw new Error(`${route} ${tool ?? "metrics"} decisions changed`)
  const decision = [...decisions][0] ?? ""
  return {
    route,
    ...(tool ? { tool } : {}),
    samples: samples.length,
    p50Ms: round(percentile(durations, 0.5)),
    p95Ms: round(percentile(durations, 0.95)),
    p99Ms: round(percentile(durations, 0.99)),
    minMs: round(durations[0] ?? 0),
    maxMs: round(durations.at(-1) ?? 0),
    rssBytes: Math.max(...samples.map((sample) => sample.rssBytes), 0),
    decisionSha256: new Bun.CryptoHasher("sha256").update(decision).digest("hex"),
  }
}

async function fixturePayload(projectRoot: string, tool: ToolName): Promise<string> {
  const suffix = tool === "Bash" ? "" : `.${tool.toLowerCase()}`
  const path = join(projectRoot, "scripts", `bench-dispatch-latency${suffix}.fixture.json`)
  const payload = JSON.parse(await Bun.file(path).text()) as Record<string, unknown>
  payload.cwd = projectRoot
  payload._agent = "codex"
  payload.request_id = `dispatch-metrics-benchmark-${tool.toLowerCase()}`
  return JSON.stringify(payload)
}

async function runWarmOnce(port: number, payload: string): Promise<Sample> {
  const startedAt = performance.now()
  const response = await fetch(
    `http://127.0.0.1:${port}/dispatch?event=preToolUse&hookEventName=PreToolUse`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
    }
  )
  const body = await response.text()
  if (!response.ok) throw new Error(`warm daemon returned HTTP ${response.status}`)
  return {
    durationMs: performance.now() - startedAt,
    decision: decisionSignature(body),
    rssBytes: 0,
  }
}

async function runColdOnce(
  indexPath: string,
  projectRoot: string,
  payload: string
): Promise<Sample> {
  const startedAt = performance.now()
  const proc = Bun.spawn(["bun", "run", indexPath, "dispatch", "preToolUse"], {
    cwd: projectRoot,
    env: { ...process.env, SWIZ_CAPTURE_INCOMING: "0" },
    stdin: new TextEncoder().encode(payload),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const exitCode = await proc.exited
  if (exitCode !== 0) throw new Error(stderr.trim() || `cold dispatch exited ${exitCode}`)
  return {
    durationMs: performance.now() - startedAt,
    decision: decisionSignature(stdout),
    rssBytes: proc.resourceUsage()?.maxRSS ?? 0,
  }
}

async function measureSeries(
  route: BenchmarkRoute,
  tool: ToolName,
  iterations: number,
  run: () => Promise<Sample>
): Promise<BenchmarkStats> {
  for (let index = 0; index < WARMUP_ITERATIONS; index++) await run()
  const samples: Sample[] = []
  for (let index = 0; index < iterations; index++) samples.push(await run())
  return summarize(route, samples, tool)
}

function measureInstrumentation(iterations: number): BenchmarkStats {
  const metrics = createMetrics()
  for (let index = 0; index < WARMUP_ITERATIONS * 20; index++) {
    recordDispatch(metrics, "preToolUse", 10, {
      route: "preToolUse",
      stages: { capture: 1, repository: 1, syncHooks: 8 },
      hookCount: 3,
    })
  }
  const samples: Sample[] = []
  const rssBefore = process.memoryUsage().rss
  for (let index = 0; index < iterations; index++) {
    const startedAt = performance.now()
    recordDispatch(metrics, "preToolUse", index % 50, {
      route: "preToolUse",
      stages: { capture: 0.5, repository: 1, enrichment: 2, syncHooks: 4, asyncHooks: 1 },
      hookCount: 5,
    })
    samples.push({
      durationMs: performance.now() - startedAt,
      decision: "instrumentation",
      rssBytes: Math.max(0, process.memoryUsage().rss - rssBefore),
    })
  }
  const stats = summarize("instrumentation", samples)
  if (stats.p50Ms >= 2) {
    throw new Error(`instrumentation p50 ${stats.p50Ms}ms exceeds the 2ms budget`)
  }
  return stats
}

async function main(): Promise<void> {
  const iterations = numberArgument("--iterations", MINIMUM_ITERATIONS)
  if (iterations < MINIMUM_ITERATIONS) {
    throw new Error(`--iterations must be at least ${MINIMUM_ITERATIONS}`)
  }
  const projectRoot = join(import.meta.dirname, "..")
  const indexPath = join(projectRoot, "index.ts")
  const port = numberArgument("--port", getDaemonPort())
  const results: BenchmarkStats[] = []

  for (const tool of selectedTools()) {
    const payload = await fixturePayload(projectRoot, tool)
    for (const route of selectedRoutes()) {
      const run =
        route === "cold-cli"
          ? () => runColdOnce(indexPath, projectRoot, payload)
          : () => runWarmOnce(port, payload)
      results.push(await measureSeries(route, tool, iterations, run))
    }
  }
  results.push(measureInstrumentation(iterations))

  const metricsResponse = await fetch(`http://127.0.0.1:${port}/metrics`)
  const daemonMetrics = metricsResponse.ok
    ? ((await metricsResponse.json()) as { memoryUsage?: { rss?: number } })
    : {}
  const daemonRssBytes = daemonMetrics.memoryUsage?.rss ?? 0
  for (const result of results) {
    if (result.route === "warm-daemon") result.rssBytes = daemonRssBytes
  }

  process.stdout.write(
    `${JSON.stringify({
      methodology: {
        fixtures: TOOLS,
        warmups: WARMUP_ITERATIONS,
        iterations,
        coldIncludesProcessBootstrap: true,
        warmMeasuresInProcessDaemonPath: true,
        rawSamplesRetained: false,
        instrumentationP50BudgetMs: 2,
      },
      results,
    })}\n`
  )
}

if (import.meta.main) {
  void main().catch((error) => {
    process.stderr.write(`benchmark-hook-dispatch: ${String(error)}\n`)
    process.exitCode = 1
  })
}
