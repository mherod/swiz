import { afterAll, describe, expect, test } from "bun:test"
import { unlink } from "node:fs/promises"
import { join } from "node:path"
import { TMP_ROOT } from "../temp-paths.ts"
import { resolveSessionLines } from "./transcript.ts"

const FALLBACK_TRANSCRIPT = join(
  TMP_ROOT,
  `transcript-session-lines-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`
)

const CURRENT_SESSION_CONSUMERS = [
  "pretooluse-no-push-when-instructed.ts",
  "pretooluse-no-phantom-task-completion.ts",
  "pretooluse-pr-head-checkout-gate.ts",
  "pretooluse-issue-workflow-gate.ts",
  "pretooluse-update-memory-enforcement.ts",
  "pretooluse-stuck-state.ts",
  "pretooluse-branch-intent-gate.ts",
  "pretooluse-infraction-escalation.ts",
  "pretooluse-offensive-language.ts",
]

afterAll(async () => {
  await unlink(FALLBACK_TRANSCRIPT).catch(() => {})
})

describe("resolveSessionLines", () => {
  test("uses valid dispatch enrichment without touching the transcript path", async () => {
    const cachedLine = JSON.stringify({ type: "user", message: { content: "cached" } })

    const lines = await resolveSessionLines(
      {
        transcript_path: "\0invalid-if-read",
        _transcriptSummary: { toolNames: [], sessionLines: [cachedLine] },
      },
      "\0invalid-if-read"
    )

    expect(lines).toEqual([cachedLine])
  })

  test("falls back to the canonical session-scoped file reader", async () => {
    const before = JSON.stringify({ type: "user", message: { content: "before" } })
    const boundary = JSON.stringify({ type: "system", content: "Compacted" })
    const after = JSON.stringify({ type: "user", message: { content: "after" } })
    await Bun.write(FALLBACK_TRANSCRIPT, [before, boundary, after].join("\n"))

    expect(await resolveSessionLines({}, FALLBACK_TRANSCRIPT)).toEqual([after])
  })
})

describe("current-session transcript consumers", () => {
  test("all use the enrichment-first resolver instead of direct session reads", async () => {
    for (const filename of CURRENT_SESSION_CONSUMERS) {
      const source = await Bun.file(join(import.meta.dirname, "..", "..", "hooks", filename)).text()
      expect(source).toContain("resolveSessionLines")
      expect(source).not.toMatch(/\breadSessionLines\b/)
    }
  })
})
