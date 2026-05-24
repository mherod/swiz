import { describe, expect, it } from "bun:test"
import { getAgent } from "../../agents.ts"
import { mergeConfig } from "./config-helpers.ts"

describe("mergeConfig — Antigravity flat-lifecycle", () => {
  const antigravity = getAgent("antigravity")!

  it("renders lifecycle events as flat {type,command,timeout} entries", () => {
    const config = mergeConfig(antigravity, {})

    // Only agy's actually-firing turn-level events are installed.
    expect(Object.keys(config).sort()).toEqual(["PreInvocation", "Stop"])

    const stop = config.Stop as Array<Record<string, unknown>>
    expect(stop).toHaveLength(1)
    // Flat shape: no nested {matcher,hooks} wrapper, explicit type, no statusMessage.
    expect(stop[0]).toMatchObject({ type: "command", timeout: 180 })
    expect(stop[0]).not.toHaveProperty("hooks")
    expect(stop[0]).not.toHaveProperty("matcher")
    expect(stop[0]).not.toHaveProperty("statusMessage")
    expect(String(stop[0]!.command)).toContain("swiz dispatch --agent antigravity stop Stop")

    const pre = config.PreInvocation as Array<Record<string, unknown>>
    expect(String(pre[0]!.command)).toContain(
      "swiz dispatch --agent antigravity userPromptSubmit PreInvocation"
    )
  })

  it("does not install tool-level or session events (enum stubs in agy)", () => {
    const config = mergeConfig(antigravity, {})
    expect(config).not.toHaveProperty("PreToolUse")
    expect(config).not.toHaveProperty("PostToolUse")
    expect(config).not.toHaveProperty("SessionStart")
  })

  it("preserves user-defined lifecycle entries while replacing swiz-managed ones", () => {
    const existing = {
      Stop: [
        { type: "command", command: "echo user-hook", timeout: 5 },
        {
          type: "command",
          command:
            "command -v swiz >/dev/null 2>&1 || exit 0; swiz dispatch --agent antigravity stop Stop",
          timeout: 180,
        },
      ],
    }
    const config = mergeConfig(antigravity, existing)
    const stop = config.Stop as Array<Record<string, unknown>>
    const commands = stop.map((e) => String(e.command))
    expect(commands).toContain("echo user-hook")
    // Exactly one swiz-managed Stop dispatch entry (the old one stripped, re-added once).
    expect(commands.filter((c) => c.includes("swiz dispatch")).length).toBe(1)
  })
})
