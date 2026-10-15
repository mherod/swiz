import { expect, test } from "bun:test"
import type { TextStreamPart, ToolSet } from "ai"
import { readAiTextStream } from "./ai-stream.ts"

async function* events(parts: TextStreamPart<ToolSet>[]) {
  yield* parts
}

test("stream errors reject even after partial output", async () => {
  const parts: string[] = []
  const failure = new Error("backend disconnected")
  await expect(
    readAiTextStream(
      events([
        { type: "text-delta", id: "reply", text: "partial" },
        { type: "error", error: failure },
      ]),
      undefined,
      (text) => parts.push(text)
    )
  ).rejects.toThrow("backend disconnected")
  expect(parts).toEqual(["partial"])
})

test("an aborted empty stream rejects as cancellation", async () => {
  const controller = new AbortController()
  controller.abort()
  await expect(readAiTextStream(events([]), controller.signal)).rejects.toThrow()
})

test("an empty completed stream is not a successful reply", async () => {
  await expect(readAiTextStream(events([]))).rejects.toThrow("returned no text")
})
