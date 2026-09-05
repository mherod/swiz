import { afterEach, expect, test } from "bun:test"
import { join } from "node:path"
import { evaluatePretooluseBlockPreexistingDismissals } from "../../hooks/pretooluse-block-preexisting-dismissals.ts"
import { TMP_ROOT } from "../temp-paths.ts"
import {
  readNativeTaskToolAvailabilityFromTranscript,
  resetNativeTaskToolAvailabilityCache,
} from "./inline-hook-helpers.ts"

const paths: string[] = []
afterEach(async () => {
  resetNativeTaskToolAvailabilityCache()
  for (const path of paths.splice(0)) await Bun.file(path).delete()
})

async function history(first: object[], last: object[]): Promise<string> {
  const path = join(TMP_ROOT, `hook-history-${crypto.randomUUID()}.jsonl`)
  paths.push(path)
  const writer = Bun.file(path).writer()
  for (const entry of first) await writer.write(`${JSON.stringify(entry)}\n`)
  const padding = `${JSON.stringify({ type: "response_item", payload: { type: "function_call_output", output: "x".repeat(64 * 1024) } })}\n`
  for (let i = 0; i < 160; i++) await writer.write(padding)
  for (const entry of last) await writer.write(`${JSON.stringify(entry)}\n`)
  await writer.end()
  return path
}

test("native task evidence survives a long history and still outweighs later absence", async () => {
  const path = await history(
    [{ type: "assistant", message: { content: [{ type: "tool_use", name: "TaskCreate" }] } }],
    [{ type: "assistant", message: "No such tool available: TaskList" }]
  )
  expect(await readNativeTaskToolAvailabilityFromTranscript(path)).toBe("present")
})

test("native task absence at the end of a long cold scan is retained", async () => {
  const path = await history(
    [],
    [{ type: "assistant", message: "No such tool available: TaskList" }]
  )
  expect(await readNativeTaskToolAvailabilityFromTranscript(path)).toBe("absent")
})

test("streamed diagnostic ownership keeps evidence across compaction and large histories", async () => {
  const path = await history(
    [
      { type: "tool_result", content: "warning: compilation diagnostic" },
      { type: "system", subtype: "compact_boundary" },
    ],
    [{ type: "assistant", message: { content: "These are pre-existing warnings." } }]
  )
  const result = await evaluatePretooluseBlockPreexistingDismissals(
    {
      cwd: TMP_ROOT,
      transcript_path: path,
      tool_name: "Edit",
      tool_input: { file_path: join(TMP_ROOT, "fixture.ts"), old_string: "a", new_string: "b" },
    },
    { runtime: { isGitRepo: async () => true } }
  )
  expect(JSON.stringify(result)).toContain("deny")
  expect(JSON.stringify(result)).toContain("compilation diagnostic")
})
