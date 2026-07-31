#!/usr/bin/env bun

import { getDaemonPort } from "../src/commands/daemon/daemon-admin.ts"

interface BenchmarkResult {
  route: "warm-daemon"
  cwd: string
  port: number
  warmups: number
  iterations: number
  p50Ms: number
  p95Ms: number
  minMs: number
  maxMs: number
}

function numberArgument(name: string, fallback: number): number {
  const index = process.argv.indexOf(name)
  if (index < 0) return fallback
  const value = Number(process.argv[index + 1])
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`)
  }
  return value
}

function stringArgument(name: string, fallback: string): string {
  const index = process.argv.indexOf(name)
  if (index < 0) return fallback
  const value = process.argv[index + 1]
  if (!value) throw new Error(`${name} requires a value`)
  return value
}

function percentile(sorted: number[], fraction: number): number {
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)
  return sorted[index] ?? 0
}

async function measure(url: string, payload: string): Promise<number> {
  const startedAt = performance.now()
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: payload,
  })
  await response.text()
  if (!response.ok) throw new Error(`daemon dispatch returned HTTP ${response.status}`)
  return performance.now() - startedAt
}

export async function benchmarkHookDispatch(): Promise<BenchmarkResult> {
  // Keep one payload and daemon state fixed across the run so before/after
  // comparisons isolate dispatch work rather than fixture construction.
  const cwd = stringArgument("--cwd", process.cwd())
  const port = numberArgument("--port", getDaemonPort())
  const warmups = numberArgument("--warmups", 3)
  const iterations = numberArgument("--iterations", 20)
  const url = `http://127.0.0.1:${port}/dispatch?event=preToolUse&hookEventName=PreToolUse`
  const payload = JSON.stringify({
    cwd,
    session_id: `swiz-dispatch-benchmark-${crypto.randomUUID()}`,
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "true" },
    request_id: `swiz-dispatch-benchmark-${crypto.randomUUID()}`,
    _agent: "codex",
  })

  for (let index = 0; index < warmups; index++) await measure(url, payload)

  const samples: number[] = []
  for (let index = 0; index < iterations; index++) samples.push(await measure(url, payload))
  samples.sort((a, b) => a - b)

  return {
    route: "warm-daemon",
    cwd,
    port,
    warmups,
    iterations,
    p50Ms: Number(percentile(samples, 0.5).toFixed(2)),
    p95Ms: Number(percentile(samples, 0.95).toFixed(2)),
    minMs: Number((samples[0] ?? 0).toFixed(2)),
    maxMs: Number((samples.at(-1) ?? 0).toFixed(2)),
  }
}

if (import.meta.main) {
  void benchmarkHookDispatch()
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(`benchmark-hook-dispatch: ${String(error)}\n`)
      process.exitCode = 1
    })
}
