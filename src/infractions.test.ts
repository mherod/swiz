import { describe, expect, it } from "bun:test"
import {
  assessInfraction,
  attemptKey,
  COOLDOWN_MARKER,
  collectBlockedAttempts,
  DENY_FOOTER_MARKERS,
  evaluateInfraction,
  INFRACTION_WINDOW_MS,
  lastSettledAttempt,
  resolveCurrentAttempt,
} from "./infractions.ts"

const DENY_FOOTER = DENY_FOOTER_MARKERS[0]

/** Build an assistant tool_use JSONL line. */
function toolUseLine(opts: {
  id: string
  name: string
  input: Record<string, any>
  timestamp?: string
}): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: opts.timestamp ?? "2026-05-25T00:00:00.000Z",
    message: { content: [{ type: "tool_use", id: opts.id, name: opts.name, input: opts.input }] },
  })
}

/** Build a user tool_result JSONL line (denied when text carries the deny footer). */
function toolResultLine(opts: {
  toolUseId: string
  text: string
  isError?: boolean
  timestamp?: string
}): string {
  return JSON.stringify({
    type: "user",
    timestamp: opts.timestamp ?? "2026-05-25T00:00:01.000Z",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: opts.toolUseId,
          is_error: opts.isError ?? true,
          content: opts.text,
        },
      ],
    },
  })
}

function deniedBashAttempt(id: string, command: string, ts?: string): string[] {
  return [
    toolUseLine({ id, name: "Bash", input: { command }, timestamp: ts }),
    toolResultLine({
      toolUseId: id,
      text: `Blocked: do the thing.\n\n${DENY_FOOTER}`,
      timestamp: ts,
    }),
  ]
}

describe("attemptKey", () => {
  it("keys shell calls on the normalised, capped command", () => {
    const key = attemptKey("Bash", { command: "git   commit  -m 'x'" })
    expect(key).toBe("git commit -m 'x'")
  })

  it("keys file edits on the path", () => {
    expect(attemptKey("Edit", { file_path: "/a/b.ts" })).toBe("/a/b.ts")
    expect(attemptKey("Write", { path: "/a/c.ts" })).toBe("/a/c.ts")
  })

  it("keys other tools on the tool name", () => {
    expect(attemptKey("TaskUpdate", { taskId: "1" })).toBe("TaskUpdate")
  })

  it("returns empty key when shell command is absent", () => {
    expect(attemptKey("Bash", {})).toBe("")
  })
})

describe("collectBlockedAttempts", () => {
  it("collects only tool calls whose result carried a deny footer", () => {
    const lines = [
      // denied
      ...deniedBashAttempt("a", "git push"),
      // ordinary error, not a block
      toolUseLine({ id: "b", name: "Bash", input: { command: "bun test" } }),
      toolResultLine({ toolUseId: "b", text: "1 test failed (exit code 1)" }),
      // succeeded
      toolUseLine({ id: "c", name: "Edit", input: { file_path: "/x.ts" } }),
      JSON.stringify({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "c", content: "ok" }] },
      }),
    ]
    const attempts = collectBlockedAttempts(lines)
    expect(attempts).toHaveLength(1)
    expect(attempts[0]?.key).toBe("git push")
    expect(attempts[0]?.toolName).toBe("Bash")
  })

  it("detects denials carrying the second footer marker", () => {
    const lines = [
      toolUseLine({ id: "a", name: "Edit", input: { file_path: "/x.ts" } }),
      toolResultLine({ toolUseId: "a", text: `nope. ${DENY_FOOTER_MARKERS[1]}` }),
    ]
    expect(collectBlockedAttempts(lines)).toHaveLength(1)
  })
})

function bk(
  key: string,
  timestampMs: number | null,
  isCooldown = false
): { toolName: string; key: string; timestampMs: number | null; isCooldown: boolean } {
  return { toolName: "Bash", key, timestampMs, isCooldown }
}

describe("assessInfraction", () => {
  it("returns none with no prior denials — the first block stands alone", () => {
    const current = { toolName: "Bash", key: "git push" }
    const assessment = assessInfraction(current, [])
    expect(assessment.level).toBe("none")
    expect(assessment.priorDenialCount).toBe(0)
    expect(assessment.wantedLevel).toBe(0)
  })

  it("returns yellow (wanted level 1) after one prior denial of the same action", () => {
    const current = { toolName: "Bash", key: "git push" }
    const assessment = assessInfraction(current, [bk("git push", Date.now())])
    expect(assessment.level).toBe("yellow")
    expect(assessment.wantedLevel).toBe(1)
  })

  it("returns red (wanted level 2) after two or more prior denials of the same action", () => {
    const now = Date.now()
    const current = { toolName: "Bash", key: "git push" }
    const blocked = [bk("git push", now - 1000), bk("git push", now - 500)]
    const assessment = assessInfraction(current, blocked, now)
    expect(assessment.level).toBe("red")
    expect(assessment.priorDenialCount).toBe(2)
    expect(assessment.wantedLevel).toBe(2)
  })

  it("does not count cooldown holds as retries of the action", () => {
    const now = Date.now()
    const current = { toolName: "Bash", key: "git push" }
    // One real denial + one cooldown hold on the same key → still only yellow.
    const blocked = [bk("git push", now - 1000), bk("git push", now - 500, true)]
    expect(assessInfraction(current, blocked, now).level).toBe("yellow")
  })

  it("does not count denials of a different action", () => {
    const current = { toolName: "Bash", key: "git push" }
    const blocked = [{ toolName: "Edit", key: "/x.ts", timestampMs: Date.now(), isCooldown: false }]
    expect(assessInfraction(current, blocked).level).toBe("none")
  })

  it("ignores denials older than the window", () => {
    const now = Date.now()
    const current = { toolName: "Bash", key: "git push" }
    expect(
      assessInfraction(current, [bk("git push", now - INFRACTION_WINDOW_MS - 1)], now).level
    ).toBe("none")
  })

  it("treats null-timestamp denials as in-window (conservative)", () => {
    const current = { toolName: "Bash", key: "git push" }
    expect(assessInfraction(current, [bk("git push", null)]).level).toBe("yellow")
  })

  it("returns none when the current call has no comparable key", () => {
    const assessment = assessInfraction({ toolName: "Bash", key: "" }, [])
    expect(assessment.level).toBe("none")
  })
})

describe("resolveCurrentAttempt", () => {
  it("resolves a shell call to its command key", () => {
    expect(resolveCurrentAttempt({ tool_name: "Bash", tool_input: { command: "ls" } })).toEqual({
      toolName: "Bash",
      key: "ls",
    })
  })

  it("returns null when there is no key", () => {
    expect(resolveCurrentAttempt({ tool_name: "Bash", tool_input: {} })).toBeNull()
    expect(resolveCurrentAttempt({})).toBeNull()
  })
})

describe("end-to-end: transcript scan to assessment", () => {
  it("grades a third attempt at a twice-blocked command as red", () => {
    const ts = "2026-05-25T00:00:00.000Z"
    const nowMs = Date.parse(ts) + 1000
    const lines = [
      ...deniedBashAttempt("a", "git push", ts),
      ...deniedBashAttempt("b", "git push", ts),
    ]
    const blocked = collectBlockedAttempts(lines)
    const current = resolveCurrentAttempt({
      tool_name: "Bash",
      tool_input: { command: "git push" },
    })
    expect(current).not.toBeNull()
    const assessment = assessInfraction(current!, blocked, nowMs)
    expect(assessment.level).toBe("red")
  })
})

// ─── Wanted-level: cooldown after a red card + de-escalation ─────────────────

const ETS = "2026-05-25T00:00:00.000Z"
const ENOW = Date.parse(ETS) + 1000

/** A denied tool_use whose result carries the cooldown marker (our own hold). */
function cooldownAttempt(id: string, command: string): string[] {
  return [
    JSON.stringify({
      type: "assistant",
      timestamp: ETS,
      message: { content: [{ type: "tool_use", id, name: "Bash", input: { command } }] },
    }),
    JSON.stringify({
      type: "user",
      timestamp: ETS,
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: id,
            is_error: true,
            content: `${COOLDOWN_MARKER}.\n\n${DENY_FOOTER_MARKERS[0]}`,
          },
        ],
      },
    }),
  ]
}

/** A tool_use whose result succeeded (no deny footer). */
function succeededAttempt(id: string, command: string): string[] {
  return [
    JSON.stringify({
      type: "assistant",
      timestamp: ETS,
      message: { content: [{ type: "tool_use", id, name: "Bash", input: { command } }] },
    }),
    JSON.stringify({
      type: "user",
      timestamp: ETS,
      message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] },
    }),
  ]
}

const bash = (command: string) => ({ toolName: "Bash", key: command })

describe("evaluateInfraction — cooldown + de-escalation", () => {
  it("holds the next event (cooldown, wanted level 3) right after a red card", () => {
    // Three denials of `git push` → the last one was a red card. The next event
    // is a *different* command, which must still be held for one beat.
    const lines = [
      ...deniedBashAttempt("a", "git push", ETS),
      ...deniedBashAttempt("b", "git push", ETS),
      ...deniedBashAttempt("c", "git push", ETS),
    ]
    const out = evaluateInfraction(lines, bash("bun test"), ENOW)
    expect(out.level).toBe("cooldown")
    expect(out.wantedLevel).toBe(3)
  })

  it("re-issuing the red-carded command stays red, not cooldown", () => {
    const lines = [
      ...deniedBashAttempt("a", "git push", ETS),
      ...deniedBashAttempt("b", "git push", ETS),
      ...deniedBashAttempt("c", "git push", ETS),
    ]
    expect(evaluateInfraction(lines, bash("git push"), ENOW).level).toBe("red")
  })

  it("de-escalates to none once the cooldown has been served", () => {
    // ...red card, then the cooldown hold was served → session continues.
    const lines = [
      ...deniedBashAttempt("a", "git push", ETS),
      ...deniedBashAttempt("b", "git push", ETS),
      ...deniedBashAttempt("c", "git push", ETS),
      ...cooldownAttempt("d", "bun test"),
    ]
    expect(evaluateInfraction(lines, bash("ls"), ENOW).level).toBe("none")
  })

  it("de-escalates to none after good behaviour (a successful action)", () => {
    const lines = [
      ...deniedBashAttempt("a", "git push", ETS),
      ...deniedBashAttempt("b", "git push", ETS),
      ...deniedBashAttempt("c", "git push", ETS),
      ...succeededAttempt("d", "bun run typecheck"),
    ]
    expect(evaluateInfraction(lines, bash("ls"), ENOW).level).toBe("none")
  })

  it("does not hold when the last block was a one-off, not a red card", () => {
    // A single denial is not red — the next event should not be held.
    const lines = [...deniedBashAttempt("a", "git push", ETS)]
    expect(evaluateInfraction(lines, bash("bun test"), ENOW).level).toBe("none")
  })
})

describe("lastSettledAttempt", () => {
  it("reports the most recent settled tool call and how it resolved", () => {
    const lines = [...deniedBashAttempt("a", "git push", ETS), ...succeededAttempt("b", "ls")]
    const last = lastSettledAttempt(lines)
    expect(last).toEqual({ key: "ls", denied: false, isCooldown: false })
  })

  it("flags a cooldown hold as the most recent settled call", () => {
    const last = lastSettledAttempt(cooldownAttempt("a", "bun test"))
    expect(last).toEqual({ key: "bun test", denied: true, isCooldown: true })
  })
})
