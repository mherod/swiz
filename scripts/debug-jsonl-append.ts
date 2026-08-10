import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { appendJsonlEntry, writeJsonlFile } from "../src/utils/jsonl.ts"

const seedCount = Number.parseInt(process.argv[2] ?? "10000", 10)
const appendCount = Number.parseInt(process.argv[3] ?? "20", 10)
const tempDir = await mkdtemp(join(tmpdir(), "swiz-debug-jsonl-append-"))
const logPath = join(tempDir, "events.jsonl")
const detail = "x".repeat(256)
const seedEntries = Array.from({ length: seedCount }, (_, index) => ({
  index,
  detail,
}))

console.log("--- setup ---")
console.log({ seedCount, appendCount, logPath, detailLength: detail.length })

await writeJsonlFile(logPath, seedEntries)
const initialSize = (await Bun.file(logPath).stat()).size
console.log({ initialSize })

console.log("--- append timings ---")
const durations: number[] = []
for (let index = 0; index < appendCount; index += 1) {
  const startedAt = performance.now()
  await appendJsonlEntry(logPath, { index: seedCount + index, detail })
  const durationMs = performance.now() - startedAt
  durations.push(durationMs)
  console.log({ index, durationMs })
}

durations.sort((left, right) => left - right)
const percentile = (fraction: number): number =>
  durations[Math.min(durations.length - 1, Math.floor(durations.length * fraction))] ?? 0

console.log("--- summary ---")
console.log({
  finalSize: (await Bun.file(logPath).stat()).size,
  p50Ms: percentile(0.5),
  p95Ms: percentile(0.95),
  maxMs: durations.at(-1) ?? 0,
})
