import { describe, expect, it } from "bun:test"
import { AntigravityHooksFileSchema } from "agent-hook-schemas/antigravity"
import { getAgent } from "../../agents.ts"
import { mergeConfig } from "./config-helpers.ts"

describe("mergeConfig — Antigravity flat-lifecycle", () => {
  const antigravity = getAgent("antigravity")!

  it("renders lifecycle events as flat {type,command,timeout} entries", () => {
    const config = mergeConfig(antigravity, {})

    expect(Object.keys(config).sort()).toEqual([
      "PostToolUse",
      "PreInvocation",
      "PreToolUse",
      "Stop",
    ])
    expect(AntigravityHooksFileSchema.safeParse({ swiz: config }).success).toBe(true)

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

  it("installs nested matchers for native file tools only", () => {
    const config = mergeConfig(antigravity, {})
    for (const event of ["PreToolUse", "PostToolUse"]) {
      const groups = config[event] as Array<{ matcher: string; hooks: Array<{ command: string }> }>
      expect(groups).toHaveLength(1)
      const matcher = new RegExp(groups[0]!.matcher)
      for (const tool of ["replace_file_content", "multi_replace_file_content", "write_to_file"]) {
        expect(matcher.test(tool)).toBe(true)
      }
      expect(matcher.test("run_command")).toBe(false)
      expect(groups[0]!.hooks[0]!.command).toContain(` ${event}`)
    }
    expect(config).not.toHaveProperty("SessionStart")
  })

  it("reinstalls idempotently without losing user handlers in a mixed tool group", () => {
    const managed = mergeConfig(antigravity, {})
    const userHook = { command: "echo user-edit-hook", timeout: 5 }
    const group = managed.PreToolUse![0] as { hooks: unknown[] }
    group.hooks.push(userHook)
    const reinstalled = mergeConfig(antigravity, managed)
    expect(reinstalled.PreToolUse![0]).toMatchObject({ hooks: [userHook] })
    expect(mergeConfig(antigravity, reinstalled)).toEqual(reinstalled)
    expect(AntigravityHooksFileSchema.safeParse({ swiz: reinstalled }).success).toBe(true)
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
