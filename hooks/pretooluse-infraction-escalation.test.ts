import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isDeny } from "../src/dispatch/engine.ts"
import { evaluatePretooluseInfractionEscalation } from "./pretooluse-infraction-escalation.ts"

const DENY_FOOTER = "You must act on this now"
const TS = "2026-05-25T00:00:00.000Z"
const NOW_MS = Date.parse(TS) + 1000

function deniedBash(id: string, command: string): string[] {
  return [
    JSON.stringify({
      type: "assistant",
      timestamp: TS,
      message: { content: [{ type: "tool_use", id, name: "Bash", input: { command } }] },
    }),
    JSON.stringify({
      type: "user",
      timestamp: TS,
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: id,
            is_error: true,
            content: `Blocked.\n\n${DENY_FOOTER}`,
          },
        ],
      },
    }),
  ]
}

describe("pretooluse-infraction-escalation", () => {
  let dir: string
  let transcriptPath: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "infraction-hook-"))
    transcriptPath = join(dir, "transcript.jsonl")
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  async function writeTranscript(lines: string[]): Promise<void> {
    await writeFile(transcriptPath, lines.join("\n"))
  }

  function input(command: string): Record<string, any> {
    return {
      tool_name: "Bash",
      tool_input: { command },
      transcript_path: transcriptPath,
      _testNowMs: NOW_MS,
    }
  }

  it("passes through when there are no prior denials", async () => {
    await writeTranscript([])
    const out = await evaluatePretooluseInfractionEscalation(input("git push"))
    expect(out).toEqual({})
  })

  it("does not pile on the first block (one prior denial → yellow, not deny)", async () => {
    await writeTranscript(deniedBash("a", "git push"))
    const out = await evaluatePretooluseInfractionEscalation(input("git push"))
    expect(isDeny(out)).toBe(false)
    // yellow card surfaces advisory context
    expect(JSON.stringify(out)).toContain("blocked it")
  })

  it("hard-blocks (red card) after two prior denials of the same call", async () => {
    await writeTranscript([...deniedBash("a", "git push"), ...deniedBash("b", "git push")])
    const out = await evaluatePretooluseInfractionEscalation(input("git push"))
    expect(isDeny(out)).toBe(true)
    expect(JSON.stringify(out)).toContain("re-assess")
  })

  it("ignores denials of a different command", async () => {
    await writeTranscript([...deniedBash("a", "rm -rf /"), ...deniedBash("b", "rm -rf /")])
    const out = await evaluatePretooluseInfractionEscalation(input("git push"))
    expect(out).toEqual({})
  })
})
