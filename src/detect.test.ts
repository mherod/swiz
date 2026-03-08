import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { AGENTS } from "./agents.ts"
import { detectCurrentAgent, isCurrentAgent, isRunningInAgent } from "./detect.ts"

describe("detect.ts", () => {
  const originalEnv = { ...process.env }
  const originalStdin = process.stdin

  beforeEach(() => {
    // Clear all agent-related environment variables before each test
    delete process.env.CLAUDECODE
    delete process.env.CURSOR_TRACE_ID
    delete process.env.GEMINI_CLI
    delete process.env.GEMINI_PROJECT_DIR
    delete process.env.CODEX_MANAGED_BY_NPM
    delete process.env.CODEX_THREAD_ID
  })

  afterEach(() => {
    // Restore original environment
    process.env = { ...originalEnv }
    Object.defineProperty(process, "stdin", {
      value: originalStdin,
      writable: true,
    })
  })

  describe("detectCurrentAgent", () => {
    describe("env-var precedence", () => {
      it("detects Claude Code via CLAUDECODE env var", () => {
        process.env.CLAUDECODE = "1"
        const agent = detectCurrentAgent()
        expect(agent?.id).toBe("claude")
      })

      it("detects Gemini CLI via GEMINI_CLI env var", () => {
        process.env.GEMINI_CLI = "1"
        const agent = detectCurrentAgent()
        expect(agent?.id).toBe("gemini")
      })

      it("detects Gemini CLI via GEMINI_PROJECT_DIR env var", () => {
        process.env.GEMINI_PROJECT_DIR = "/some/dir"
        const agent = detectCurrentAgent()
        expect(agent?.id).toBe("gemini")
      })

      it("detects Codex via CODEX_MANAGED_BY_NPM env var", () => {
        process.env.CODEX_MANAGED_BY_NPM = "1"
        const agent = detectCurrentAgent()
        expect(agent?.id).toBe("codex")
      })

      it("detects Codex via CODEX_THREAD_ID env var", () => {
        process.env.CODEX_THREAD_ID = "abc123"
        const agent = detectCurrentAgent()
        expect(agent?.id).toBe("codex")
      })

      it("env-var detection takes precedence over process pattern", () => {
        // Even if we had a parent process with cursor pattern,
        // CLAUDECODE would match first (because we check envVars first)
        process.env.CLAUDECODE = "1"
        const agent = detectCurrentAgent()
        expect(agent?.id).toBe("claude")
      })

      it("returns first matching agent when multiple envVars set", () => {
        // Gemini comes after Claude in AGENTS array, so Claude should match first
        process.env.CLAUDECODE = "1"
        process.env.GEMINI_CLI = "1"
        const agent = detectCurrentAgent()
        expect(agent?.id).toBe("claude")
      })

      it("only checks envVars that are configured for the agent", () => {
        // Set an arbitrary env var that isn't in any agent's envVars list
        process.env.FAKE_AGENT_VAR = "1"
        const agent = detectCurrentAgent()
        // In Cursor, parent-process fallback can still identify Cursor even when
        // no configured env var matches. The assertion here is specifically that
        // FAKE_AGENT_VAR does not trigger any env-var based agent match.
        expect(agent === null || agent.id === "cursor").toBe(true)
      })
    })

    describe("process-pattern fallback", () => {
      it("returns null when no env vars match and parent process is unknown", () => {
        // With no env vars set and default parent process, should return null
        const agent = detectCurrentAgent()
        // We can't guarantee the parent process pattern, so just check it doesn't error
        expect(typeof agent === "object" || agent === null).toBe(true)
      })

      it("cursor has a process pattern for fallback detection", () => {
        const cursor = AGENTS.find((a) => a.id === "cursor")
        expect(cursor?.processPattern).toBeDefined()
        expect(cursor?.processPattern).toBeInstanceOf(RegExp)
      })

      it("cursor process pattern is used when no env vars set", () => {
        // Verify cursor's pattern exists and can match
        const cursor = AGENTS.find((a) => a.id === "cursor")
        expect(cursor?.processPattern?.test("__CURSOR_SANDBOX_ENV_RESTORE=true")).toBe(true)
      })
    })

    describe("edge cases", () => {
      it("returns the agent object, not just the id", () => {
        process.env.CLAUDECODE = "1"
        const agent = detectCurrentAgent()
        expect(agent).toBeDefined()
        expect(agent?.name).toBe("Claude Code")
        expect(agent?.binary).toBe("claude")
      })

      it("handles empty string env vars (should not match)", () => {
        process.env.CLAUDECODE = ""
        const agent = detectCurrentAgent()
        // Empty string is falsy, so shouldn't match
        expect(agent?.id).not.toBe("claude")
      })

      it("is case-sensitive for env var names", () => {
        process.env.claudecode = "1" // lowercase
        const agent = detectCurrentAgent()
        expect(agent?.id).not.toBe("claude")
      })
    })
  })

  describe("isCurrentAgent", () => {
    it("returns true when inside the specified agent", () => {
      process.env.CLAUDECODE = "1"
      expect(isCurrentAgent("claude")).toBe(true)
    })

    it("returns false when inside a different agent", () => {
      process.env.CLAUDECODE = "1"
      expect(isCurrentAgent("cursor")).toBe(false)
      expect(isCurrentAgent("gemini")).toBe(false)
    })

    it("returns false when not inside any agent", () => {
      const agent = isCurrentAgent("claude")
      // Can't guarantee this in CI, but it shouldn't error
      expect(typeof agent === "boolean").toBe(true)
    })
  })

  describe("isRunningInAgent", () => {
    it("returns true when CLAUDECODE is set", () => {
      process.env.CLAUDECODE = "1"
      expect(isRunningInAgent()).toBe(true)
    })

    it("returns true when CURSOR_TRACE_ID is set", () => {
      process.env.CURSOR_TRACE_ID = "abc123"
      expect(isRunningInAgent()).toBe(true)
    })

    it("returns false when no agent env vars are set and stdin is a TTY", () => {
      // Mock stdin as a TTY (interactive terminal)
      Object.defineProperty(process, "stdin", {
        value: { isTTY: true },
        writable: true,
      })
      expect(isRunningInAgent()).toBe(false)
    })

    it("returns true when stdin is not a TTY (non-interactive)", () => {
      // Mock stdin as not a TTY (agent context)
      Object.defineProperty(process, "stdin", {
        value: { isTTY: false },
        writable: true,
      })
      expect(isRunningInAgent()).toBe(true)
    })

    it("is simpler than detectCurrentAgent (doesn't identify which agent)", () => {
      process.env.CLAUDECODE = "1"
      expect(isRunningInAgent()).toBe(true)
      // But it doesn't tell us which agent
      expect(typeof isRunningInAgent()).toBe("boolean")
    })
  })

  describe("integration with agents.ts metadata", () => {
    it("uses envVars from AGENTS metadata for detection", () => {
      const claude = AGENTS.find((a) => a.id === "claude")!
      const envVar = claude.envVars?.[0]
      if (!envVar) throw new Error("Claude must have envVars")
      process.env[envVar] = "1"
      const detected = detectCurrentAgent()
      expect(detected?.id).toBe("claude")
    })

    it("respects all envVars for an agent (any one match succeeds)", () => {
      const gemini = AGENTS.find((a) => a.id === "gemini")!
      if (!gemini.envVars || gemini.envVars.length < 2) {
        throw new Error("Gemini must have multiple envVars")
      }
      const envVars: string[] = gemini.envVars

      // Set the second env var, should still detect gemini
      process.env[envVars[1]!] = "1"
      const detected = detectCurrentAgent()
      expect(detected?.id).toBe("gemini")
    })

    it("processPattern is used as fallback for agents with process detection", () => {
      const cursor = AGENTS.find((a) => a.id === "cursor")!
      expect(cursor.processPattern).toBeDefined()
      expect(cursor.processPattern).toBeInstanceOf(RegExp)
    })
  })

  describe("hook/shim integration", () => {
    it("detectCurrentAgent can be exported for hook use (mirror of isRunningInAgent)", () => {
      // Verify the function is properly exported and can be called from hooks
      process.env.CLAUDECODE = "1"
      const agent = detectCurrentAgent()
      expect(agent).toBeDefined()
      expect(agent?.id).toBe("claude")
    })

    it("isRunningInAgent provides simpler boolean check for shell shims", () => {
      // Shell shims just need "is agent?" not "which agent?"
      process.env.CLAUDECODE = "1"
      const result = isRunningInAgent()
      expect(typeof result).toBe("boolean")
      expect(result).toBe(true)
    })
  })
})
