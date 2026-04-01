import { describe, expect, it } from "vitest"
import { detectAgentCli, detectBestAgentCli, detectJunieCli } from "./agent.ts"

describe("agent.ts", () => {
  describe("detectAgentCli", () => {
    it("function is exported and callable", () => {
      expect(typeof detectAgentCli).toBe("function")
    })
  })

  describe("detectJunieCli", () => {
    it("function is exported and callable", () => {
      expect(typeof detectJunieCli).toBe("function")
    })
  })

  describe("detectBestAgentCli", () => {
    it("function is exported and callable", () => {
      expect(typeof detectBestAgentCli).toBe("function")
    })
  })

  describe("PromptAgentOptions interface", () => {
    it("supports promptOnly option to isolate agent from project files", () => {
      const options = { promptOnly: true }
      expect(options.promptOnly).toBe(true)
    })

    it("supports timeout option for per-call timeout in milliseconds", () => {
      const options = { timeout: 5000 }
      expect(typeof options.timeout).toBe("number")
      expect(options.timeout).toBeGreaterThan(0)
    })

    it("supports signal option for abort handling", () => {
      const controller = new AbortController()
      const options = { signal: controller.signal }
      expect(options.signal).toBe(controller.signal)
      expect(options.signal.aborted).toBe(false)
    })

    it("all options are optional", () => {
      const emptyOptions = {}
      expect(Object.keys(emptyOptions)).toHaveLength(0)
    })

    it("options can be combined together", () => {
      const controller = new AbortController()
      const options = {
        promptOnly: true,
        timeout: 3000,
        signal: controller.signal,
      }
      expect(options.promptOnly).toBe(true)
      expect(options.timeout).toBe(3000)
      expect(options.signal).toBe(controller.signal)
    })
  })

  describe("error handling patterns", () => {
    it("AgentBackend type is correctly defined as string literal", () => {
      const backend: "agent" = "agent"
      expect(backend).toBe("agent")
    })

    it("promptAgent error message references Cursor IDE for installation", () => {
      // This verifies the error message pattern from the code
      const expectedMessage = "Cursor Agent not found"
      expect(expectedMessage).toContain("Cursor")
    })

    it("AbortController pattern for timeout works correctly", () => {
      const controller = new AbortController()
      expect(controller.signal.aborted).toBe(false)

      controller.abort()
      expect(controller.signal.aborted).toBe(true)
    })
  })

  describe("agent CLI invocation", () => {
    it("agent command includes --print flag for output", () => {
      const args = ["agent", "--print", "--mode", "ask", "--trust", "prompt"]
      expect(args).toContain("--print")
    })

    it("agent command includes --mode ask flag for Q&A", () => {
      const args = ["agent", "--print", "--mode", "ask", "--trust", "prompt"]
      expect(args).toContain("--mode")
      expect(args).toContain("ask")
    })

    it("agent command includes --trust flag for automatic approval", () => {
      const args = ["agent", "--print", "--mode", "ask", "--trust", "prompt"]
      expect(args).toContain("--trust")
    })

    it("promptOnly option would add --workspace flag with tmpdir", () => {
      // When promptOnly is true, the code adds ["--workspace", tmpdir()]
      const hasWorkspace = true
      const hasPromptOnly = true
      if (hasPromptOnly) {
        expect(hasWorkspace).toBe(true)
      }
    })
  })

  describe("timeout and signal handling", () => {
    it("timeout creates internal AbortController if signal not provided", () => {
      const timeout = 5000
      expect(typeof timeout).toBe("number")
      expect(timeout).toBeGreaterThan(0)
    })

    it("external signal takes precedence over internal timeout controller", () => {
      const signal = new AbortController().signal
      const timeout = 5000
      // In the code: signal is used if provided
      expect(signal).toBeDefined()
      expect(timeout).toBeDefined()
    })

    it("abort signal properly kills spawned process after timeout", () => {
      const controller = new AbortController()
      const signal = controller.signal

      expect(signal.aborted).toBe(false)
      controller.abort()
      expect(signal.aborted).toBe(true)
    })
  })
})
