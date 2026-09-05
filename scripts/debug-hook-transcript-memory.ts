import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { evaluatePretooluseBlockPreexistingDismissals } from "../hooks/pretooluse-block-preexisting-dismissals.ts"
import { evaluateUserpromptsubmitSkillSteps } from "../hooks/userpromptsubmit-skill-steps.ts"
import { findLastUserMessageMsFromTranscript } from "../src/commands/daemon/cache/last-user-message-cache.ts"
import { TMP_ROOT } from "../src/temp-paths.ts"
import { readNativeTaskToolAvailabilityFromTranscript } from "../src/utils/inline-hook-helpers.ts"

/** Synthetic hook probe: prints only sizes, timing and derived results. */
const mode = process.argv[2] ?? "activity"
const sizeMiB = Number(process.argv[3] ?? 32)
if (!["activity", "activity-miss", "prompt", "availability", "diagnostics"].includes(mode))
  throw new Error("Unknown probe mode")
if (!Number.isSafeInteger(sizeMiB) || sizeMiB < 1 || sizeMiB > 64) {
  throw new Error("Expected a fixture size between 1 and 64 MiB")
}
const dir = join(TMP_ROOT, `swiz-hook-memory-${crypto.randomUUID()}`)
await mkdir(dir, { recursive: true })
const path = join(dir, "session.jsonl")
const writer = Bun.file(path).writer()
const line = `${JSON.stringify({
  type: "response_item",
  payload: { type: "function_call_output", output: "x".repeat(32 * 1024) },
})}\n`
for (let bytes = 0; bytes < sizeMiB * 1024 ** 2; bytes += line.length) await writer.write(line)
const timestamp = "2026-09-05T10:00:00Z"
if (mode !== "activity-miss")
  await writer.write(
    `${JSON.stringify({
      type: "response_item",
      timestamp,
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Continue" }],
      },
    })}\n`
  )
await writer.end()

function snapshot(phase: string): void {
  Bun.gc(true)
  console.error(JSON.stringify({ phase, ...process.memoryUsage() }))
}

console.error(JSON.stringify({ mode, runtime: Bun.version, fixtureBytes: Bun.file(path).size }))
snapshot("baseline")
const startedAt = performance.now()
let result: unknown
if (mode === "activity" || mode === "activity-miss")
  result = await findLastUserMessageMsFromTranscript(path)
else if (mode === "availability") result = await readNativeTaskToolAvailabilityFromTranscript(path)
else if (mode === "diagnostics") {
  result = await evaluatePretooluseBlockPreexistingDismissals(
    {
      cwd: dir,
      transcript_path: path,
      tool_name: "Edit",
      tool_input: { file_path: join(dir, "example.ts"), old_string: "a", new_string: "b" },
    },
    { runtime: { isGitRepo: async () => true } }
  )
} else {
  result = await evaluateUserpromptsubmitSkillSteps({
    cwd: dir,
    session_id: `probe-${crypto.randomUUID()}`,
    transcript_path: path,
    prompt: "Continue",
  })
}
console.error(JSON.stringify({ result, elapsedMs: performance.now() - startedAt }))
snapshot("after")
await Bun.file(path).delete()
