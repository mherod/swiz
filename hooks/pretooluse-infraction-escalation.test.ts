import { describe, expect, it } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isDeny } from "../src/dispatch/engine.ts"
import { COOLDOWN_MARKER } from "../src/infractions.ts"
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

// A Skill tool_use the recency parser detects. Timestamped ~now so it lands inside
// the recency window (which compares to Date.now(), independent of _testNowMs).
function skillInvocation(skill: string): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: new Date(Date.now() - 1000).toISOString(),
    message: { content: [{ type: "tool_use", name: "Skill", input: { skill } }] },
  })
}

describe("pretooluse-infraction-escalation", () => {
  function input(command: string, transcriptPath: string): Record<string, unknown> {
    return {
      tool_name: "Bash",
      tool_input: { command },
      transcript_path: transcriptPath,
      _testNowMs: NOW_MS,
    }
  }

  // Fully self-contained per test: create the temp transcript, run, then clean up
  // in finally. No describe-scope mutable state to be clobbered under --concurrent.
  async function evalWith(
    lines: string[],
    command: string
  ): Promise<Awaited<ReturnType<typeof evaluatePretooluseInfractionEscalation>>> {
    const dir = await mkdtemp(join(tmpdir(), "infraction-hook-"))
    try {
      const transcriptPath = join(dir, "transcript.jsonl")
      await writeFile(transcriptPath, lines.join("\n"))
      return await evaluatePretooluseInfractionEscalation(input(command, transcriptPath))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  it("passes through when there are no prior denials", async () => {
    expect(await evalWith([], "git push")).toEqual({})
  })

  it("does not pile on the first block (one prior denial → yellow, not deny)", async () => {
    const out = await evalWith(deniedBash("a", "git push"), "git push")
    expect(isDeny(out)).toBe(false)
    // yellow card surfaces advisory context naming the prior block
    expect(JSON.stringify(out)).toContain("blocked it")
  })

  it("hard-blocks (red card) after two prior denials of the same call", async () => {
    const out = await evalWith(
      [...deniedBash("a", "git push"), ...deniedBash("b", "git push")],
      "git push"
    )
    expect(isDeny(out)).toBe(true)
    expect(JSON.stringify(out)).toContain("re-assess")
  })

  it("ignores denials of a different command", async () => {
    const out = await evalWith(
      [...deniedBash("a", "rm -rf /"), ...deniedBash("b", "rm -rf /")],
      "git push"
    )
    expect(out).toEqual({})
  })

  it("holds the next event after a red card with a cooldown block", async () => {
    // Three denials of git push → red. The next event (a different command) is held.
    const out = await evalWith(
      [
        ...deniedBash("a", "git push"),
        ...deniedBash("b", "git push"),
        ...deniedBash("c", "git push"),
      ],
      "bun test"
    )
    expect(isDeny(out)).toBe(true)
    // The cooldown block carries the marker verbatim (survives the rephraser).
    expect(JSON.stringify(out)).toContain(COOLDOWN_MARKER)
  })

  it("stands down the red card when /re-assess was used recently", async () => {
    const out = await evalWith(
      [
        ...deniedBash("a", "git push"),
        ...deniedBash("b", "git push"),
        skillInvocation("re-assess"),
      ],
      "git push"
    )
    expect(out).toEqual({})
  })

  it("stands down the red card when /unblock-myself was used recently", async () => {
    const out = await evalWith(
      [
        ...deniedBash("a", "git push"),
        ...deniedBash("b", "git push"),
        skillInvocation("unblock-myself"),
      ],
      "git push"
    )
    expect(out).toEqual({})
  })

  it("still hard-blocks when an unrelated skill was used", async () => {
    const out = await evalWith(
      [...deniedBash("a", "git push"), ...deniedBash("b", "git push"), skillInvocation("commit")],
      "git push"
    )
    expect(isDeny(out)).toBe(true)
    expect(JSON.stringify(out)).toContain("re-assess")
  })

  it("stands down the cooldown hold when /re-assess was used recently", async () => {
    const out = await evalWith(
      [
        ...deniedBash("a", "git push"),
        ...deniedBash("b", "git push"),
        ...deniedBash("c", "git push"),
        skillInvocation("re-assess"),
      ],
      "bun test"
    )
    expect(out).toEqual({})
  })
})
