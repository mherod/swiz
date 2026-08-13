import { describe, expect, test } from "bun:test"
import { mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { TMP_ROOT } from "../../temp-paths.ts"
import { sessionDataCache } from "./session-data.ts"

const TEST_DIR = join(TMP_ROOT, "swiz-session-data-tests")

describe("sessionDataCache", () => {
  test("assigns a stable fallback to malformed message timestamps", async () => {
    await rm(TEST_DIR, { recursive: true, force: true })
    await mkdir(TEST_DIR, { recursive: true })
    const path = join(TEST_DIR, "malformed-timestamp.jsonl")
    await Bun.write(
      path,
      `${JSON.stringify({
        type: "assistant",
        timestamp: "not-a-timestamp",
        message: { content: [{ type: "text", text: "hello" }] },
      })}\n`
    )

    try {
      const result = await sessionDataCache.get({ path, format: "jsonl" })
      const assignedTimestamp = result?.messages[0]?.timestamp

      expect(result).not.toBeNull()
      expect(assignedTimestamp).not.toBe("not-a-timestamp")
      expect(Number.isFinite(Date.parse(assignedTimestamp ?? ""))).toBe(true)
      expect(Number.isFinite(result?.startedAt)).toBe(true)
      expect(Number.isFinite(result?.lastMessageAt)).toBe(true)
    } finally {
      sessionDataCache.invalidateAll()
      await rm(TEST_DIR, { recursive: true, force: true })
    }
  })
})
