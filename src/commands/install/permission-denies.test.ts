import { describe, expect, it } from "bun:test"
import { evaluatePretooluseBannedCommands } from "../../../hooks/pretooluse-banned-commands.ts"
import { getAgent } from "../../agents.ts"
import {
  swizPermissionDenies,
  withoutSwizPermissionDenies,
  withSwizPermissionDenies,
} from "./permission-denies.ts"

const claude = getAgent("claude")!
const codex = getAgent("codex")!

describe("withSwizPermissionDenies", () => {
  it("creates the deny list when settings have no permissions", () => {
    expect(withSwizPermissionDenies({ model: "opus" }, claude)).toEqual({
      model: "opus",
      permissions: { deny: ["Bash(cd:*)"] },
    })
  })

  it("appends after user entries and keeps sibling permission keys", () => {
    const settings = { permissions: { allow: ["Read"], deny: ["Bash(rm:*)"] } }
    expect(withSwizPermissionDenies(settings, claude)).toEqual({
      permissions: { allow: ["Read"], deny: ["Bash(rm:*)", "Bash(cd:*)"] },
    })
  })

  it("is idempotent when the entry already exists", () => {
    const settings = { permissions: { deny: ["Bash(cd:*)", "Bash(rm:*)"] } }
    expect(withSwizPermissionDenies(settings, claude)).toBe(settings)
  })

  it("leaves malformed permission shapes untouched", () => {
    const settings = { permissions: { deny: "Bash(rm:*)" } }
    expect(withSwizPermissionDenies(settings, claude)).toBe(settings)
  })

  it("adds nothing for agents without managed denies", () => {
    const settings = { hooks: {} }
    expect(withSwizPermissionDenies(settings, codex)).toBe(settings)
  })
})

describe("withoutSwizPermissionDenies", () => {
  it("removes only managed entries", () => {
    const settings = { permissions: { deny: ["Bash(rm:*)", "Bash(cd:*)"] } }
    expect(withoutSwizPermissionDenies(settings, claude)).toEqual({
      settings: { permissions: { deny: ["Bash(rm:*)"] } },
      removed: 1,
    })
  })

  it("drops containers the managed entries leave empty", () => {
    const settings = { model: "opus", permissions: { deny: ["Bash(cd:*)"] } }
    expect(withoutSwizPermissionDenies(settings, claude)).toEqual({
      settings: { model: "opus" },
      removed: 1,
    })
  })

  it("reports zero removals when nothing is managed", () => {
    const settings = { permissions: { allow: ["Read"] } }
    expect(withoutSwizPermissionDenies(settings, claude)).toEqual({ settings, removed: 0 })
  })
})

describe("managed denies stay within the hook's unconditional bans", () => {
  // A settings deny cannot be overridden by allow and has no guidance text, so every
  // command a managed pattern matches must already be denied by the hook.
  const samples: Record<string, string[]> = {
    "Bash(cd:*)": ["cd", "cd /tmp", "cd .. && ls", "cd ~/project"],
  }

  it("has hook-denied samples for every managed pattern", () => {
    expect(Object.keys(samples).sort()).toEqual([...swizPermissionDenies(claude)].sort())
  })

  for (const [pattern, commands] of Object.entries(samples)) {
    for (const command of commands) {
      it(`${pattern}: hook denies \`${command}\``, async () => {
        const output = await evaluatePretooluseBannedCommands({
          session_id: "permission-denies-test",
          tool_name: "Bash",
          tool_input: { command },
          cwd: "/tmp",
          hook_event_name: "PreToolUse",
        })
        expect(JSON.stringify(output)).toContain('"deny"')
      })
    }
  }
})
