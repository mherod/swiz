/**
 * Reproducible latency benchmark for the controlled Bash pre-hook path (#752).
 *
 * Two measurements, both driven from one committed fixture so runs are
 * comparable across machines and commits:
 *
 *   1. `dispatch` — end-to-end `swiz dispatch preToolUse` invocations. This is
 *      the number the acceptance criterion is written against.
 *   2. `probe` — an A/B of the repository-capability lookup alone: cached (the
 *      behaviour this change introduces) against forced re-probe (what every
 *      call site did before it). Isolates the change from CLI startup noise,
 *      which dominates the end-to-end figure.
 *
 * Methodology is fixed by the acceptance criteria: 3 warm-up iterations, then at
 * least 20 sequential measured iterations against the same payload, cwd, and
 * daemon state. Median and p95 are reported for each series.
 *
 * Usage:
 *   bun run scripts/bench-dispatch-latency.ts
 *   bun run scripts/bench-dispatch-latency.ts --iterations 40 --only probe
 */

import { join } from "node:path"

const WARMUP_ITERATIONS = 3
const DEFAULT_MEASURED_ITERATIONS = 20

interface Stats {
  label: string
  samples: number
  medianMs: number
  p95Ms: number
  minMs: number
  maxMs: number
}

function percentile(sortedMs: number[], fraction: number): number {
  if (sortedMs.length === 0) return Number.NaN
  // Nearest-rank: the smallest value at or above the requested fraction.
  const rank = Math.ceil(fraction * sortedMs.length)
  const index = Math.min(Math.max(rank - 1, 0), sortedMs.length - 1)
  return sortedMs[index]!
}

function summarize(label: string, durationsMs: number[]): Stats {
  const sorted = [...durationsMs].sort((a, b) => a - b)
  return {
    label,
    samples: sorted.length,
    medianMs: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    minMs: sorted[0] ?? Number.NaN,
    maxMs: sorted[sorted.length - 1] ?? Number.NaN,
  }
}

async function timeSeries(
  label: string,
  iterations: number,
  run: () => Promise<void>
): Promise<Stats> {
  for (let i = 0; i < WARMUP_ITERATIONS; i++) await run()

  const durationsMs: number[] = []
  for (let i = 0; i < iterations; i++) {
    const started = performance.now()
    await run()
    durationsMs.push(performance.now() - started)
  }
  return summarize(label, durationsMs)
}

async function runDispatchOnce(indexPath: string, payload: string, cwd: string): Promise<void> {
  const proc = Bun.spawn(["bun", "run", indexPath, "dispatch", "preToolUse"], {
    cwd,
    stdin: new TextEncoder().encode(payload),
    stdout: "pipe",
    stderr: "pipe",
  })
  await new Response(proc.stdout).text()
  await new Response(proc.stderr).text()
  await proc.exited
}

function parseArgs(argv: string[]): { iterations: number; only: string | null } {
  let iterations = DEFAULT_MEASURED_ITERATIONS
  let only: string | null = null
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--iterations" && argv[i + 1]) {
      const parsed = Number.parseInt(argv[i + 1]!, 10)
      if (Number.isFinite(parsed) && parsed > 0) iterations = parsed
      i++
    } else if (argv[i] === "--only" && argv[i + 1]) {
      only = argv[i + 1]!
      i++
    }
  }
  if (iterations < DEFAULT_MEASURED_ITERATIONS) {
    console.error(
      `[bench] refusing ${iterations} iterations — the acceptance criteria require at least ${DEFAULT_MEASURED_ITERATIONS}`
    )
    process.exit(1)
  }
  return { iterations, only }
}

function report(stats: Stats[]): void {
  console.error("")
  console.error("  series                     n   median      p95      min      max")
  console.error("  ────────────────────────────────────────────────────────────────")
  for (const s of stats) {
    console.error(
      `  ${s.label.padEnd(22)} ${String(s.samples).padStart(4)} ` +
        `${s.medianMs.toFixed(2).padStart(8)} ${s.p95Ms.toFixed(2).padStart(8)} ` +
        `${s.minMs.toFixed(2).padStart(8)} ${s.maxMs.toFixed(2).padStart(8)}   (ms)`
    )
  }
  console.error("")
}

async function main(): Promise<void> {
  const { iterations, only } = parseArgs(process.argv.slice(2))
  const projectRoot = join(import.meta.dirname, "..")
  const indexPath = join(projectRoot, "index.ts")
  const fixturePath = join(projectRoot, "scripts", "bench-dispatch-latency.fixture.json")
  const payload = await Bun.file(fixturePath).text()

  console.error(`[bench] fixture: ${fixturePath}`)
  console.error(`[bench] cwd: ${projectRoot}`)
  console.error(`[bench] ${WARMUP_ITERATIONS} warm-up + ${iterations} measured iterations`)

  const stats: Stats[] = []

  if (only === null || only === "probe") {
    // Imported lazily so `--only dispatch` still runs against a checkout that
    // predates this module — which is how the before/after comparison is taken.
    const { resolveRepositoryCapability } = await import("../src/repository-capability.ts")
    // "before": every call re-probes, as each of the four pre-#752 call sites did.
    stats.push(
      await timeSeries("probe:uncached", iterations, async () => {
        await resolveRepositoryCapability(projectRoot, { forceRefresh: true })
      })
    )
    // "after": the second and later lookups in a dispatch hit the cache.
    stats.push(
      await timeSeries("probe:cached", iterations, async () => {
        await resolveRepositoryCapability(projectRoot)
      })
    )
  }

  if (only === null || only === "dispatch") {
    stats.push(
      await timeSeries("dispatch:end-to-end", iterations, () =>
        runDispatchOnce(indexPath, payload, projectRoot)
      )
    )
  }

  report(stats)

  const uncached = stats.find((s) => s.label === "probe:uncached")
  const cached = stats.find((s) => s.label === "probe:cached")
  if (uncached && cached) {
    const savedPerReuse = uncached.medianMs - cached.medianMs
    // Pre-#752 a daemon-backed dispatch probed the repository four times: the CLI
    // non-git fast path, the CLI pre-command replay, the core dispatch
    // short-circuit, and the replay inside prepareDispatchGroups. Three of those
    // are now reuses.
    console.error(
      `[bench] per-reuse saving: ${savedPerReuse.toFixed(2)}ms median ` +
        `→ ${(savedPerReuse * 3).toFixed(2)}ms across the 3 eliminated probes`
    )
  }
}

await main()
