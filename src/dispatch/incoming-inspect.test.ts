import { describe, expect, it } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  computeStats,
  filterByCanonicalEvent,
  getParseErrors,
  listCaptureFiles,
  loadCapture,
} from "./incoming-inspect.ts"

function capture(parseError = false): Record<string, unknown> {
  return {
    _swizIncomingCapture: {
      formatVersion: 2,
      canonicalEvent: "preToolUse",
      hookEventName: "PreToolUse",
      capturedAt: new Date().toISOString(),
      parseError,
      payloadBytes: 12,
    },
    incoming: parseError ? undefined : { tool_name: "Bash" },
  }
}

describe("incoming capture inspector", () => {
  it("ignores raw companions, malformed JSON, and invalid envelopes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "swiz-incoming-inspect-"))
    await Promise.all([
      writeFile(join(dir, "valid.json"), JSON.stringify(capture())),
      writeFile(join(dir, "valid.raw.json"), '{"secret":"exact"}'),
      writeFile(join(dir, "malformed.json"), "{"),
      writeFile(join(dir, "unrelated.json"), JSON.stringify({ hello: "world" })),
    ])

    expect((await listCaptureFiles(dir)).map((file) => file.name).sort()).toEqual([
      "malformed.json",
      "unrelated.json",
      "valid.json",
    ])
    expect(await loadCapture("valid.raw.json", dir)).toBeNull()
    expect(await loadCapture("malformed.json", dir)).toBeNull()
    expect(await loadCapture("unrelated.json", dir)).toBeNull()
    expect((await computeStats(dir)).total).toBe(1)
    expect(await filterByCanonicalEvent("preToolUse", dir)).toHaveLength(1)
  })

  it("reports valid parse-error envelopes without raw payload data", async () => {
    const dir = await mkdtemp(join(tmpdir(), "swiz-incoming-errors-"))
    await writeFile(join(dir, "error.json"), JSON.stringify(capture(true)))

    const errors = await getParseErrors(dir)

    expect(errors).toHaveLength(1)
    expect(errors[0]?.capture._swizIncomingCapture.payloadBytes).toBe(12)
    expect(errors[0]?.capture).not.toHaveProperty("rawPayload")
  })
})
