import { afterEach, expect, test } from "bun:test"
import { join } from "node:path"
import { readSubmittedUserMessage } from "../../hooks/userpromptsubmit-skill-steps.ts"
import { findLastUserMessageMsFromTranscript } from "../commands/daemon/cache/last-user-message-cache.ts"
import { TMP_ROOT } from "../temp-paths.ts"
import { readLastTranscriptUserMessage } from "./transcript-user-message.ts"

const paths: string[] = []
afterEach(async () => {
  for (const path of paths.splice(0)) await Bun.file(path).delete()
})

async function fixture(entries: object[]): Promise<string> {
  const path = join(TMP_ROOT, `user-message-${crypto.randomUUID()}.jsonl`)
  paths.push(path)
  await Bun.write(path, entries.map((entry) => JSON.stringify(entry)).join("\n"))
  return path
}

test("Codex response messages provide current user text and activity time", async () => {
  const timestamp = "2026-09-05T10:00:00Z"
  const path = await fixture([
    {
      type: "response_item",
      timestamp,
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "/commit café 🦊" }],
      },
    },
    {
      type: "response_item",
      payload: { type: "function_call_output", output: "not a user message" },
    },
  ])
  expect(await readLastTranscriptUserMessage(path)).toEqual({
    text: "/commit café 🦊",
    at: Date.parse(timestamp),
  })
  expect(await findLastUserMessageMsFromTranscript(path)).toBe(Date.parse(timestamp))
  expect(await readSubmittedUserMessage({ transcript_path: path })).toBe("/commit café 🦊")
})

test("Codex event user messages are recognised", async () => {
  const path = await fixture([
    {
      type: "event_msg",
      timestamp: "2026-09-05T10:00:00Z",
      payload: { type: "user_message", message: "Continue" },
    },
  ])
  expect((await readLastTranscriptUserMessage(path))?.text).toBe("Continue")
})

test("submitted prompts take precedence over older transcript skill invocations", async () => {
  const path = await fixture([{ type: "user", message: { content: "/commit" } }])
  expect(await readSubmittedUserMessage({ prompt: "Continue", transcript_path: path })).toBe(
    "Continue"
  )
  expect(await readSubmittedUserMessage({ prompt: "", transcript_path: path })).toBe("")
  expect(await readSubmittedUserMessage({ prompt: "/commit" })).toBe("/commit")
})

test("tool results and blank content do not replace a genuine Claude user message", async () => {
  const path = await fixture([
    { type: "human", message: { content: "Please continue" } },
    {
      type: "user",
      message: {
        content: [
          { type: "tool_result", content: "/commit" },
          { type: "text", text: "wrapper" },
        ],
      },
    },
    { type: "user", message: { content: " " } },
  ])
  expect((await readLastTranscriptUserMessage(path))?.text).toBe("Please continue")
})

test("timestamp lookups skip invalid dates without losing the latest prompt text", async () => {
  const timestamp = "2026-09-05T10:00:00Z"
  const path = await fixture([
    { type: "user", timestamp, message: { content: "earlier" } },
    { type: "user", timestamp: "invalid", message: { content: "latest" } },
  ])
  expect((await readLastTranscriptUserMessage(path))?.text).toBe("latest")
  expect(await findLastUserMessageMsFromTranscript(path)).toBe(Date.parse(timestamp))
})
