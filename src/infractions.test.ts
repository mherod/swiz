import { describe, expect, it } from "bun:test"
import {
  assessInfraction,
  attemptKey,
  COOLDOWN_MARKER,
  collectBlockedAttempts,
  complianceBaselineWantedLevel,
  evaluateInfraction,
  INFRACTION_DENIAL_MARKER,
  INFRACTION_WINDOW_MS,
  lastSettledAttempt,
  RETRY_ALLOWED_DENIAL_MARKER,
  resolveCurrentAttempt,
  standingWantedLevel,
} from "./infractions.ts"

/** The mandate footer swiz appends to every denial (src/SwizHook.ts preToolUseDenyWithSystemMessage). */
const DENY_FOOTER =
  "You must act on this now. Do not try to stop again without completing the required action."

/** How Claude Code records a PreToolUse hook denial: an is_error result opening with this wrapper. */
const hookDenial = (tool: string, reason: string) => `PreToolUse:${tool} hook error: ${reason}`

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
      text: hookDenial("Bash", `Blocked: do the thing.\n\n${DENY_FOOTER}`),
      timestamp: ts,
    }),
  ]
}

function infractionDeniedBashAttempt(id: string, command: string, ts?: string): string[] {
  return [
    toolUseLine({ id, name: "Bash", input: { command }, timestamp: ts }),
    toolResultLine({
      toolUseId: id,
      text: hookDenial("Bash", `Blocked by ${INFRACTION_DENIAL_MARKER}.\n\n${DENY_FOOTER}`),
      timestamp: ts,
    }),
  ]
}

function retryAllowedDeniedBashAttempt(id: string, command: string, ts?: string): string[] {
  return [
    toolUseLine({ id, name: "Bash", input: { command }, timestamp: ts }),
    toolResultLine({
      toolUseId: id,
      text: hookDenial(
        "Bash",
        `${RETRY_ALLOWED_DENIAL_MARKER}: retry this command.\n\n${DENY_FOOTER}`
      ),
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

  // #964: keys were cut at 60 characters, so a corrected command collided with the one denied.
  it("keeps commands that differ only after character 60 apart", () => {
    const base = "gh issue edit 956 --body-file /private/tmp/claude-501/-Users-someone-Development-"
    expect(base.length).toBeGreaterThan(60)
    expect(attemptKey("Bash", { command: `${base}a.md` })).not.toBe(
      attemptKey("Bash", { command: `${base}b.md` })
    )
  })
})

describe("retry-after-block with a corrected command (#964)", () => {
  const TS = "2026-05-25T00:00:00.000Z"
  const NOW = Date.parse(TS) + 1000
  const run = 'bun test src/pretooluse-require-tasks.test.ts -t "in_progress" 2>&1'

  it("does not escalate a new filter after a denied one and a compliant run", () => {
    const lines = [
      ...deniedBashAttempt("a", `${run} | tail -8`, TS),
      // The compliant retry ran; one failing test's output quoted a hook message.
      toolUseLine({
        id: "b",
        name: "Bash",
        input: { command: `${run} | tail -15` },
        timestamp: TS,
      }),
      toolResultLine({
        toolUseId: "b",
        isError: false,
        text: `(fail) x\n${DENY_FOOTER}`,
        timestamp: TS,
      }),
    ]
    const current = resolveCurrentAttempt({
      tool_name: "Bash",
      tool_input: { command: `${run} | tail -12` },
    })
    expect(evaluateInfraction(lines, current!, NOW).level).toBe("none")
  })

  it("control: re-issuing the exact denied command still escalates yellow then red", () => {
    const command = `${run} | tail -8`
    const current = resolveCurrentAttempt({ tool_name: "Bash", tool_input: { command } })
    const once = deniedBashAttempt("a", command, TS)
    expect(evaluateInfraction(once, current!, NOW).level).toBe("yellow")
    const twice = [...once, ...deniedBashAttempt("b", command, TS)]
    expect(evaluateInfraction(twice, current!, NOW).level).toBe("red")
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

  it("detects hook denials of non-shell tools", () => {
    const lines = [
      toolUseLine({ id: "a", name: "Edit", input: { file_path: "/x.ts" } }),
      toolResultLine({ toolUseId: "a", text: hookDenial("Edit", "nope. Resolve this block.") }),
    ]
    expect(collectBlockedAttempts(lines)).toHaveLength(1)
  })

  // #964: output that merely quotes deny text was counted as a denial, so a compliant run
  // added to the retry count.
  it("never counts a successful result, whatever its output quotes", () => {
    const lines = [
      toolUseLine({ id: "a", name: "Bash", input: { command: "bun test src/x.test.ts" } }),
      toolResultLine({
        toolUseId: "a",
        isError: false,
        text: `1 fail\nexpected: "Blocked. ${DENY_FOOTER}"\nRan 3 tests`,
      }),
    ]
    expect(collectBlockedAttempts(lines)).toEqual([])
  })

  it("never counts a failed command that prints deny text", () => {
    const lines = [
      toolUseLine({ id: "a", name: "Bash", input: { command: "bun test src/x.test.ts" } }),
      toolResultLine({ toolUseId: "a", text: `Exit code 1\n${hookDenial("Bash", DENY_FOOTER)}` }),
    ]
    expect(collectBlockedAttempts(lines)).toEqual([])
  })
})

function bk(
  key: string,
  timestampMs: number | null,
  isCooldown = false,
  isInfractionDenial = false,
  isRetryAllowed = false
): {
  toolName: string
  key: string
  timestampMs: number | null
  isCooldown: boolean
  isInfractionDenial: boolean
  isRetryAllowed: boolean
} {
  return { toolName: "Bash", key, timestampMs, isCooldown, isInfractionDenial, isRetryAllowed }
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

  it("does not count the detector's own denial against the same retry budget", () => {
    const now = Date.now()
    const current = { toolName: "Bash", key: "git push" }
    const blocked = [bk("git push", now - 1000), bk("git push", now - 500, false, true)]
    expect(assessInfraction(current, blocked, now).level).toBe("yellow")
  })

  it("does not count denials that explicitly permit retrying the same action", () => {
    const now = Date.now()
    const current = { toolName: "Bash", key: "git add src/guardian-review.ts" }
    const blocked = [
      bk("git add src/guardian-review.ts", now - 1000, false, false, true),
      bk("git add src/guardian-review.ts", now - 500, false, false, true),
    ]
    expect(assessInfraction(current, blocked, now).level).toBe("none")
  })

  it("does not count denials of a different action", () => {
    const current = { toolName: "Bash", key: "git push" }
    const blocked = [
      {
        toolName: "Edit",
        key: "/x.ts",
        timestampMs: Date.now(),
        isCooldown: false,
        isInfractionDenial: false,
        isRetryAllowed: false,
      },
    ]
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
            content: hookDenial("Bash", `${COOLDOWN_MARKER}.\n\n${DENY_FOOTER}`),
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

/** A successful (non-denied) call of a named tool, e.g. Skill / WebSearch / TaskCreate. */
function succeededTool(id: string, name: string): string[] {
  return [
    JSON.stringify({
      type: "assistant",
      timestamp: ETS,
      message: { content: [{ type: "tool_use", id, name, input: {} }] },
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

  it("does not worsen the retry count when the preceding red denial came from this detector", () => {
    const lines = [
      ...deniedBashAttempt("a", "git push", ETS),
      ...deniedBashAttempt("b", "git push", ETS),
      ...infractionDeniedBashAttempt("c", "git push", ETS),
    ]
    const out = evaluateInfraction(lines, bash("git push"), ENOW)
    expect(out.level).toBe("red")
    expect(out.priorDenialCount).toBe(2)
  })

  it("passes yellow through when the current call is a first retry", () => {
    const lines = [...deniedBashAttempt("a", "git push", ETS)]
    expect(evaluateInfraction(lines, bash("git push"), ENOW).level).toBe("yellow")
  })

  it("does not hard-block or cool down an explicitly permitted retry sequence", () => {
    const lines = [
      ...retryAllowedDeniedBashAttempt("a", "git add src/guardian-review.ts", ETS),
      ...retryAllowedDeniedBashAttempt("b", "git add src/guardian-review.ts", ETS),
      ...retryAllowedDeniedBashAttempt("c", "git add src/guardian-review.ts", ETS),
    ]
    expect(evaluateInfraction(lines, bash("git add src/guardian-review.ts"), ENOW).level).toBe(
      "none"
    )
    expect(evaluateInfraction(lines, bash("bun test"), ENOW).level).toBe("none")
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

describe("complianceBaselineWantedLevel", () => {
  it("is 0 when there are no incomplete tasks", () => {
    expect(complianceBaselineWantedLevel(null)).toBe(0)
    expect(complianceBaselineWantedLevel({ incomplete: 0, pending: 0, inProgress: 0 })).toBe(0)
  })

  it("is 0 when task governance is healthy (≥1 in_progress, ≥1 pending, ≥2 incomplete)", () => {
    expect(complianceBaselineWantedLevel({ incomplete: 3, pending: 2, inProgress: 1 })).toBe(0)
  })

  it("is 1 when task governance is unhealthy with incomplete work", () => {
    // in_progress only, no pending buffer → unhealthy
    expect(complianceBaselineWantedLevel({ incomplete: 1, pending: 0, inProgress: 1 })).toBe(1)
    // no in_progress → unhealthy
    expect(complianceBaselineWantedLevel({ incomplete: 2, pending: 2, inProgress: 0 })).toBe(1)
  })
})

describe("standingWantedLevel", () => {
  it("is clear (0) on an empty transcript", () => {
    expect(standingWantedLevel([], ENOW).wantedLevel).toBe(0)
  })

  it("reads ★1 (yellow) when the most recent action was blocked once", () => {
    const lines = [...deniedBashAttempt("a", "git push", ETS)]
    const out = standingWantedLevel(lines, ENOW)
    expect(out.level).toBe("yellow")
    expect(out.wantedLevel).toBe(1)
  })

  it("reads ★2 (red) when the most recent action was blocked three+ times", () => {
    const lines = [
      ...deniedBashAttempt("a", "git push", ETS),
      ...deniedBashAttempt("b", "git push", ETS),
      ...deniedBashAttempt("c", "git push", ETS),
    ]
    expect(standingWantedLevel(lines, ENOW).wantedLevel).toBe(2)
  })

  it.each([
    "Skill",
    "WebSearch",
    "TaskCreate",
  ])("de-escalates to clear after good behaviour: %s", (tool) => {
    const lines = [
      ...deniedBashAttempt("a", "git push", ETS),
      ...deniedBashAttempt("b", "git push", ETS),
      ...deniedBashAttempt("c", "git push", ETS),
      ...succeededTool("d", tool),
    ]
    expect(standingWantedLevel(lines, ENOW).wantedLevel).toBe(0)
  })

  it("clears after good behaviour (a successful most-recent action)", () => {
    const lines = [
      ...deniedBashAttempt("a", "git push", ETS),
      ...deniedBashAttempt("b", "git push", ETS),
      ...deniedBashAttempt("c", "git push", ETS),
      ...succeededAttempt("d", "bun test"),
    ]
    expect(standingWantedLevel(lines, ENOW).wantedLevel).toBe(0)
  })

  it("clears once a cooldown has been served", () => {
    const lines = [
      ...deniedBashAttempt("a", "git push", ETS),
      ...deniedBashAttempt("b", "git push", ETS),
      ...deniedBashAttempt("c", "git push", ETS),
      ...cooldownAttempt("d", "bun test"),
    ]
    expect(standingWantedLevel(lines, ENOW).wantedLevel).toBe(0)
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
