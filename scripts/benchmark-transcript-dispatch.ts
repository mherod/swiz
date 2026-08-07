#!/usr/bin/env bun

import { mkdtemp, rmdir, unlink } from "node:fs/promises"
import { join } from "node:path"
import { getDaemonPort } from "../src/commands/daemon/daemon-admin.ts"
import { TMP_ROOT } from "../src/temp-paths.ts"

const MINIMUM_ITERATIONS = 200
const WARMUP_ITERATIONS = 5
const FIXTURE_BYTES = 1024 * 1024

function numberArgument(name: string, fallback: number): number {
  const index = process.argv.indexOf(name)
  if (index < 0) return fallback
  const value = Number(process.argv[index + 1])
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`)
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

function buildFixture(): string {
  const lines = [JSON.stringify({ type: "system", content: "Compacted" })]
  for (let index = 0; lines.join("\n").length < FIXTURE_BYTES; index++) {
    lines.push(
      JSON.stringify({
        type: "user",
        timestamp: new Date(1_700_000_000_000 + index * 1000).toISOString(),
        message: { content: `benchmark ${index} ${"x".repeat(2048)}` },
      })
    )
  }
  return lines.join("\n")
}

async function measure(
  url: string,
  payload: string
): Promise<{ durationMs: number; body: string }> {
  const startedAt = performance.now()
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: payload,
  })
  const body = await response.text()
  if (!response.ok) throw new Error(`daemon dispatch returned HTTP ${response.status}`)
  return { durationMs: performance.now() - startedAt, body }
}

async function benchmark(): Promise<Record<string, unknown>> {
  const port = numberArgument("--port", getDaemonPort())
  const iterations = numberArgument("--iterations", MINIMUM_ITERATIONS)
  if (iterations < MINIMUM_ITERATIONS) {
    throw new Error(`--iterations must be at least ${MINIMUM_ITERATIONS}`)
  }
  const cwd = stringArgument("--cwd", process.cwd())
  const tempDir = await mkdtemp(join(TMP_ROOT, "swiz-transcript-dispatch-bench-"))
  const transcriptPath = join(tempDir, "transcript.jsonl")

  try {
    const fixture = buildFixture()
    await Bun.write(transcriptPath, fixture)
    const url = `http://127.0.0.1:${port}/dispatch?event=preToolUse&hookEventName=PreToolUse`
    const payload = JSON.stringify({
      cwd,
      session_id: `transcript-dispatch-benchmark-${port}`,
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "git status --short" },
      transcript_path: transcriptPath,
      request_id: `transcript-dispatch-benchmark-${port}`,
      _agent: "codex",
    })

    for (let index = 0; index < WARMUP_ITERATIONS; index++) await measure(url, payload)

    const samples: number[] = []
    const responseBodies = new Set<string>()
    for (let index = 0; index < iterations; index++) {
      const sample = await measure(url, payload)
      samples.push(sample.durationMs)
      responseBodies.add(sample.body)
    }
    if (responseBodies.size !== 1) throw new Error("hook decisions changed during benchmark")

    samples.sort((a, b) => a - b)
    const responseBody = [...responseBodies][0] ?? ""
    const responseSha256 = new Bun.CryptoHasher("sha256").update(responseBody).digest("hex")
    return {
      route: "warm-daemon-transcript",
      port,
      fixtureBytes: (await Bun.file(transcriptPath).stat()).size,
      warmups: WARMUP_ITERATIONS,
      iterations,
      p50Ms: Number(percentile(samples, 0.5).toFixed(2)),
      p95Ms: Number(percentile(samples, 0.95).toFixed(2)),
      minMs: Number((samples[0] ?? 0).toFixed(2)),
      maxMs: Number((samples.at(-1) ?? 0).toFixed(2)),
      responseSha256,
    }
  } finally {
    await unlink(transcriptPath).catch(() => {})
    await rmdir(tempDir).catch(() => {})
  }
}

if (import.meta.main) {
  void benchmark()
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(`benchmark-transcript-dispatch: ${String(error)}\n`)
      process.exitCode = 1
    })
}
