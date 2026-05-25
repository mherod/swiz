import { afterEach, describe, expect, it } from "bun:test"
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
  // Each test owns its own temp dir/path via a local const — describe-scope
  // mutable state would be clobbered under `bun test --concurrent`.
  const dirsToClean: string[] = []

  afterEach(async () => {
    await Promise.all(dirsToClean.splice(0).map((d) => rm(d, { recursive: true, force: true })))
  })

  async function writeTranscript(lines: string[]): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "infraction-hook-"))
    dirsToClean.push(dir)
    const transcriptPath = join(dir, "transcript.jsonl")
    await writeFile(transcriptPath, lines.join("\n"))
    return transcriptPath
  }

  function input(command: string, transcriptPath: string): Record<string, unknown> {
    return {
      tool_name: "Bash",
      tool_input: { command },
      transcript_path: transcriptPath,
      _testNowMs: NOW_MS,
    }
  }

  it("passes through when there are no prior denials", async () => {
    const transcriptPath = await writeTranscript([])
    const out = await evaluatePretooluseInfractionEscalation(input("git push", transcriptPath))
    expect(out).toEqual({})
  })

  it("does not pile on the first block (one prior denial → yellow, not deny)", async () => {
    const transcriptPath = await writeTranscript(deniedBash("a", "git push"))
    const out = await evaluatePretooluseInfractionEscalation(input("git push", transcriptPath))
    expect(isDeny(out)).toBe(false)
    // yellow card surfaces advisory context naming the prior block
    expect(JSON.stringify(out)).toContain("blocked it")
  })

  it("hard-blocks (red card) after two prior denials of the same call", async () => {
    const transcriptPath = await writeTranscript([
      ...deniedBash("a", "git push"),
      ...deniedBash("b", "git push"),
    ])
    const out = await evaluatePretooluseInfractionEscalation(input("git push", transcriptPath))
    expect(isDeny(out)).toBe(true)
    expect(JSON.stringify(out)).toContain("re-assess")
  })

  it("ignores denials of a different command", async () => {
    const transcriptPath = await writeTranscript([
      ...deniedBash("a", "rm -rf /"),
      ...deniedBash("b", "rm -rf /"),
    ])
    const out = await evaluatePretooluseInfractionEscalation(input("git push", transcriptPath))
    expect(out).toEqual({})
  })
})
