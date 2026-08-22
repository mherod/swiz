import { describe, expect, test } from "bun:test"
import { CooldownRegistry } from "./cooldown-registry.ts"

describe("CooldownRegistry session scoping (issue #847)", () => {
  test("session-scoped windows are independent per session", () => {
    const registry = new CooldownRegistry()
    registry.mark("hook.ts", "/repo", "session-a")
    expect(registry.isWithinCooldown("hook.ts", 60, "/repo", "session-a")).toBe(true)
    expect(registry.isWithinCooldown("hook.ts", 60, "/repo", "session-b")).toBe(false)
    // Control: omitting the session keeps the separate repo-scoped key.
    expect(registry.isWithinCooldown("hook.ts", 60, "/repo")).toBe(false)
  })

  test("invalidateProject clears repo-scoped AND session-scoped entries", () => {
    const registry = new CooldownRegistry()
    registry.mark("hook.ts", "/repo")
    registry.mark("hook.ts", "/repo", "session-a")
    registry.mark("hook.ts", "/other", "session-a")
    registry.invalidateProject("/repo")
    expect(registry.isWithinCooldown("hook.ts", 60, "/repo")).toBe(false)
    // A plain suffix match would leave this session-scoped entry behind.
    expect(registry.isWithinCooldown("hook.ts", 60, "/repo", "session-a")).toBe(false)
    // Control: the other project's entry survives.
    expect(registry.isWithinCooldown("hook.ts", 60, "/other", "session-a")).toBe(true)
  })
})
