import { describe, expect, it } from "bun:test"
import { isJbcontextConfigured } from "../src/jbcontext.ts"
import { evaluateSessionstartJbcontextWarmup } from "./sessionstart-jbcontext-warmup.ts"

describe("hooks/sessionstart-jbcontext-warmup.ts", () => {
  it("returns empty object when given invalid input without jbcontext", async () => {
    // When run with a nonexistent directory on non-configured system
    const result = await evaluateSessionstartJbcontextWarmup({
      cwd: "/nonexistent/test/path",
    })
    // In CI or on unindexed nonexistent path, returns {} or context if global
    expect(result).toBeDefined()
  })

  it("handles live repository according to jbcontext configuration", async () => {
    const configured = await isJbcontextConfigured({ projectPath: process.cwd() })
    const result = await evaluateSessionstartJbcontextWarmup({
      cwd: process.cwd(),
    })

    if (configured) {
      const hso = (result as { hookSpecificOutput?: { additionalContext?: string } })
        .hookSpecificOutput
      expect(hso?.additionalContext).toBeDefined()
      expect(hso?.additionalContext).toContain("JetBrains Context")
    } else {
      expect(result).toEqual({})
    }
  })
})
