import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { sessionDataCache } from "../src/commands/daemon/session-data.ts"
import { TMP_ROOT } from "../src/temp-paths.ts"

/** Bounded synthetic reproduction; never loads a user's transcript. */
const sizeMiB = Number(process.argv[2] ?? 32)
if (!Number.isSafeInteger(sizeMiB) || sizeMiB < 1 || sizeMiB > 64) {
  throw new Error("Expected a fixture size between 1 and 64 MiB")
}
const dir = join(TMP_ROOT, `swiz-preview-memory-${crypto.randomUUID()}`)
await mkdir(dir, { recursive: true })
const path = join(dir, "preview.jsonl")
const writer = Bun.file(path).writer()
const line = `${JSON.stringify({
  type: "response_item",
  timestamp: "2026-09-05T10:00:00Z",
  payload: { type: "function_call_output", output: "x".repeat(32 * 1024) },
})}\n`
for (let bytes = 0; bytes < sizeMiB * 1024 ** 2; bytes += line.length) await writer.write(line)
await writer.write(
  `${JSON.stringify({
    type: "response_item",
    timestamp: "2026-09-05T10:01:00Z",
    payload: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Recent answer" }],
    },
  })}\n`
)
await writer.end()

function snapshot(phase: string): void {
  Bun.gc(true)
  console.error(JSON.stringify({ phase, ...process.memoryUsage() }))
}

console.error(JSON.stringify({ runtime: Bun.version, fixtureBytes: Bun.file(path).size, path }))
snapshot("baseline")
for (let iteration = 0; iteration < 3; iteration++) {
  sessionDataCache.invalidateAll()
  const startedAt = performance.now()
  const result = await sessionDataCache.get({ path, format: "codex-jsonl" }, dir)
  console.error(
    JSON.stringify({
      iteration,
      elapsedMs: performance.now() - startedAt,
      messages: result?.messages.length,
    })
  )
  if (result?.messages.at(-1)?.text !== "Recent answer") throw new Error("Recent message lost")
  snapshot(`preview-${iteration}`)
}
sessionDataCache.invalidateAll()
snapshot("released")
