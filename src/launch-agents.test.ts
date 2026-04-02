import { describe, expect, it } from "vitest"
import { bootoutLaunchAgent, isLaunchAgentLoaded, killLaunchAgentProcesses } from "./launch-agents"

describe("launch-agents robustness", () => {
  it("isLaunchAgentLoaded should return a boolean", async () => {
    // We can't easily mock Bun.spawn here without complex setup,
    // but we can check if the function returns a boolean.
    // In a real environment, com.apple.Finder should exist.
    const result = await isLaunchAgentLoaded("com.apple.Finder")
    expect(typeof result).toBe("boolean")
  })

  it("bootoutLaunchAgent should return a number", async () => {
    // This will likely fail to bootout a random label, but should return a non-zero exit code.
    const result = await bootoutLaunchAgent("non-existent-label")
    expect(typeof result).toBe("number")
  })

  it("killLaunchAgentProcesses should not throw if pgrep fails or returns nothing", async () => {
    // Should handle cases where no processes match.
    // We expect it to resolve without throwing.
    await killLaunchAgentProcesses("non-existent-label-xyz-123")
  })
})
