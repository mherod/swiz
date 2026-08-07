#!/usr/bin/env bun

import { join } from "node:path"
import { launchAsyncHooks } from "../src/dispatch/engine.ts"
import { DEFAULT_WORKER_POOL_SIZE, WorkerPool } from "../src/dispatch/worker-pool.ts"
import type { HookGroup } from "../src/manifest.ts"

const POOL_SIZES = [1, 2, 4, 8]
const WARMUPS = 2
const JOBS = 24
const HOOK_DELAY_MS = 25
const TEST_HOOK = "../src/dispatch/fixtures/worker-pool-hook.ts"

interface PoolBenchmark {
  size: number
  jobs: number
  p95Ms: number
  throughputPerSecond: number
  rssDeltaBytes: number
  averageQueueDelayMs: number
  maxQueueDelayMs: number
}

function percentile(sorted: number[], fraction: number): number {
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)
  return sorted[index] ?? 0
}

async function benchmarkSize(size: number): Promise<PoolBenchmark> {
  const pool = new WorkerPool({ size })
  const rssBefore = process.memoryUsage().rss
  try {
    pool.initialize()
    for (let index = 0; index < WARMUPS; index++) {
      await pool.runHook(TEST_HOOK, JSON.stringify({ label: `warmup-${index}` }), 2)
    }

    const startedAt = performance.now()
    const samples = await Promise.all(
      Array.from({ length: JOBS }, (_, index) => {
        const jobStartedAt = performance.now()
        return pool
          .runHook(TEST_HOOK, JSON.stringify({ delayMs: HOOK_DELAY_MS, label: `job-${index}` }), 2)
          .then(() => performance.now() - jobStartedAt)
      })
    )
    const durationMs = performance.now() - startedAt
    samples.sort((a, b) => a - b)
    const metrics = pool.getMetrics()

    return {
      size,
      jobs: JOBS,
      p95Ms: Number(percentile(samples, 0.95).toFixed(2)),
      throughputPerSecond: Number(((JOBS / durationMs) * 1000).toFixed(2)),
      rssDeltaBytes: Math.max(0, process.memoryUsage().rss - rssBefore),
      averageQueueDelayMs: metrics.averageQueueDelayMs,
      maxQueueDelayMs: metrics.maxQueueDelayMs,
    }
  } finally {
    pool.terminate()
  }
}

async function runIsolatedSize(size: number): Promise<PoolBenchmark> {
  const projectRoot = join(import.meta.dirname, "..")
  const proc = Bun.spawn(["bun", "run", import.meta.path, "--size", String(size)], {
    cwd: projectRoot,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const exitCode = await proc.exited
  if (exitCode !== 0) throw new Error(stderr.trim() || `pool-size benchmark ${size} failed`)
  return JSON.parse(stdout) as PoolBenchmark
}

async function measureInlineOnlyDispatch(): Promise<{
  rssDeltaBytes: number
  workerPoolRequests: number
}> {
  let workerPoolRequests = 0
  const groups: HookGroup[] = [
    {
      event: "stop",
      hooks: [
        {
          hook: {
            name: "benchmark-inline-async.ts",
            event: "stop",
            async: true,
            async run() {
              return {}
            },
          },
        },
      ],
    },
  ]
  const rssBefore = process.memoryUsage().rss
  await launchAsyncHooks(groups, "{}", true, undefined, {
    workerPoolProvider: () => {
      workerPoolRequests += 1
      throw new Error("inline-only dispatch requested the worker pool")
    },
  })
  return {
    rssDeltaBytes: Math.max(0, process.memoryUsage().rss - rssBefore),
    workerPoolRequests,
  }
}

async function main(): Promise<void> {
  const sizeIndex = process.argv.indexOf("--size")
  if (sizeIndex >= 0) {
    const size = Number.parseInt(process.argv[sizeIndex + 1] ?? "", 10)
    if (!Number.isInteger(size) || size < 1) throw new Error("--size must be a positive integer")
    process.stdout.write(`${JSON.stringify(await benchmarkSize(size))}\n`)
    return
  }

  const results: PoolBenchmark[] = []
  for (const size of POOL_SIZES) results.push(await runIsolatedSize(size))
  process.stdout.write(
    `${JSON.stringify({
      defaultSize: DEFAULT_WORKER_POOL_SIZE,
      methodology: {
        warmups: WARMUPS,
        jobs: JOBS,
        hookDelayMs: HOOK_DELAY_MS,
        isolatedProcessPerSize: true,
      },
      inlineOnly: await measureInlineOnlyDispatch(),
      pools: results,
    })}\n`
  )
}

if (import.meta.main) {
  void main().catch((error) => {
    process.stderr.write(`benchmark-worker-pool: ${String(error)}\n`)
    process.exitCode = 1
  })
}
