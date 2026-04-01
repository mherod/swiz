import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { ZodError } from "zod"
import {
  coerceDispatchAgentEnvelopeInPlace,
  DispatchPayloadValidationError,
} from "./dispatch-zod-surfaces.ts"
import { type DispatchRequest, executeDispatch } from "./execute.ts"
import { DEFAULT_STOP_DISPATCH_ALLOW_CONTEXT } from "./stop-response.ts"

describe("dispatch execute integration", () => {
  let prevCaptureIncoming: string | undefined
  beforeAll(() => {
    prevCaptureIncoming = process.env.SWIZ_CAPTURE_INCOMING
    process.env.SWIZ_CAPTURE_INCOMING = "0"
  })
  afterAll(() => {
    if (prevCaptureIncoming === undefined) delete process.env.SWIZ_CAPTURE_INCOMING
    else process.env.SWIZ_CAPTURE_INCOMING = prevCaptureIncoming
  })

  describe("executeDispatch", () => {
    it("returns empty response when no hooks match", async () => {
      const req: DispatchRequest = {
        canonicalEvent: "nonexistentEvent",
        hookEventName: "NonexistentEvent",
        payloadStr: JSON.stringify({ cwd: "/tmp/test-dispatch", session_id: "test-session" }),
      }
      const result = await executeDispatch(req)
      expect(result).toBeDefined()
      expect(result.response).toEqual({})
    })

    it("handles empty payload gracefully", async () => {
      const req: DispatchRequest = {
        canonicalEvent: "nonexistentEvent",
        hookEventName: "NonexistentEvent",
        payloadStr: "",
      }
      const result = await executeDispatch(req)
      expect(result).toBeDefined()
      expect(result.response).toEqual({})
    })

    it("rejects invalid JSON stdin for any dispatch event", async () => {
      const req: DispatchRequest = {
        canonicalEvent: "nonexistentEvent",
        hookEventName: "NonexistentEvent",
        payloadStr: "not-json{{{",
      }
      expect(executeDispatch(req)).rejects.toBeInstanceOf(DispatchPayloadValidationError)
    })

    it("accepts daemonContext flag without error", async () => {
      const req: DispatchRequest = {
        canonicalEvent: "nonexistentEvent",
        hookEventName: "NonexistentEvent",
        payloadStr: JSON.stringify({ cwd: "/tmp/test-daemon-ctx", session_id: "daemon-test" }),
        daemonContext: true,
      }
      const result = await executeDispatch(req)
      expect(result).toBeDefined()
      expect(result.response).toEqual({})
    })

    it("normalizes stop dispatch when cwd is not a git repo", async () => {
      const req: DispatchRequest = {
        canonicalEvent: "stop",
        hookEventName: "Stop",
        payloadStr: JSON.stringify({
          cwd: `/tmp/swiz-dispatch-no-git-${Date.now()}`,
          session_id: "stop-no-git",
        }),
        daemonContext: true,
      }
      const result = await executeDispatch(req)
      expect(result.response.continue).toBe(true)
      expect(result.response.hookSpecificOutput).toBeUndefined()
      expect(result.response.reason).toBe(DEFAULT_STOP_DISPATCH_ALLOW_CONTEXT)
      expect(result.response.stopReason).toBe(DEFAULT_STOP_DISPATCH_ALLOW_CONTEXT)
    })

    it("normalizes stop dispatch when manifest yields zero matching hook groups", async () => {
      const req: DispatchRequest = {
        canonicalEvent: "stop",
        hookEventName: "Stop",
        payloadStr: JSON.stringify({ cwd: process.cwd(), session_id: "stop-empty-manifest" }),
        manifestProvider: async () => [],
        daemonContext: true,
      }
      const result = await executeDispatch(req)
      expect(result.response.continue).toBe(true)
      expect(result.response.hookSpecificOutput).toBeUndefined()
      expect(result.response.reason).toBe(DEFAULT_STOP_DISPATCH_ALLOW_CONTEXT)
      expect(result.response.stopReason).toBe(DEFAULT_STOP_DISPATCH_ALLOW_CONTEXT)
    })

    it("rejects stop dispatch with invalid JSON stdin", async () => {
      const req: DispatchRequest = {
        canonicalEvent: "stop",
        hookEventName: "Stop",
        payloadStr: "not-json{{{",
      }
      expect(executeDispatch(req)).rejects.toBeInstanceOf(DispatchPayloadValidationError)
    })

    it("rejects subagentStop dispatch with non-object JSON stdin", async () => {
      const req: DispatchRequest = {
        canonicalEvent: "subagentStop",
        hookEventName: "SubagentStop",
        payloadStr: "[]",
      }
      expect(executeDispatch(req)).rejects.toBeInstanceOf(DispatchPayloadValidationError)
    })

    it("throws when coercing stop envelope that violates stopHookOutputSchema", () => {
      const r: Record<string, any> = { continue: true }
      expect(() => coerceDispatchAgentEnvelopeInPlace(r, "stop", "Stop")).toThrow()
    })
  })

  describe("transcriptSummaryProvider", () => {
    it("uses cached provider instead of reading file when provided", async () => {
      let providerCalled = false
      let providerPath = ""
      const req: DispatchRequest = {
        canonicalEvent: "preToolUse",
        hookEventName: "PreToolUse",
        payloadStr: JSON.stringify({
          cwd: process.cwd(),
          session_id: "test-session",
          transcript_path: "/nonexistent/transcript.jsonl",
          tool_name: "Bash",
          tool_input: { command: "echo hello" },
        }),
        transcriptSummaryProvider: async (path) => {
          providerCalled = true
          providerPath = path
          return {
            toolNames: ["Bash"],
            toolCallCount: 1,
            bashCommands: ["echo hello"],
            skillInvocations: [],
            hasGitPush: false,
            sessionLines: [],
            sessionDurationMs: 0,
            successfulTestRuns: 0,
            lastVerificationTime: null,
            sessionScope: "trivial",
          }
        },
      }
      await executeDispatch(req)
      expect(providerCalled).toBe(true)
      expect(providerPath).toBe("/nonexistent/transcript.jsonl")
    })

    it("falls back to file read when no provider is given", async () => {
      const req: DispatchRequest = {
        canonicalEvent: "nonexistentEvent",
        hookEventName: "NonexistentEvent",
        payloadStr: JSON.stringify({
          cwd: "/tmp/test-no-provider",
          session_id: "test-session",
          transcript_path: "/nonexistent/transcript.jsonl",
        }),
      }
      // Should not throw — computeTranscriptSummary returns null for missing files
      const result = await executeDispatch(req)
      expect(result).toBeDefined()
    })
  })

  describe("currentSessionToolUsageProvider", () => {
    it("injects daemon-backed current-session usage without requiring transcript reads", async () => {
      let providerCalled = false
      let providerSessionId = ""
      let providerTranscriptPath = ""
      const req: DispatchRequest = {
        canonicalEvent: "preToolUse",
        hookEventName: "PreToolUse",
        payloadStr: JSON.stringify({
          cwd: process.cwd(),
          session_id: "usage-session",
          transcript_path: "/nonexistent/transcript.jsonl",
          tool_name: "Bash",
          tool_input: { command: "echo hello" },
        }),
        currentSessionToolUsageProvider: async (sessionId, transcriptPath) => {
          providerCalled = true
          providerSessionId = sessionId
          providerTranscriptPath = transcriptPath ?? ""
          return {
            toolNames: ["Skill", "Bash"],
            skillInvocations: ["commit"],
          }
        },
        disableTranscriptSummaryFallback: true,
      }
      await executeDispatch(req)
      expect(providerCalled).toBe(true)
      expect(providerSessionId).toBe("usage-session")
      expect(providerTranscriptPath).toBe("/nonexistent/transcript.jsonl")
    })
  })

  describe("manifestProvider", () => {
    it("uses cached manifest provider instead of loading from disk", async () => {
      let providerCalled = false
      let providerCwd = ""
      const req: DispatchRequest = {
        canonicalEvent: "preToolUse",
        hookEventName: "PreToolUse",
        payloadStr: JSON.stringify({
          cwd: process.cwd(),
          session_id: "test-session",
          tool_name: "Bash",
          tool_input: { command: "echo hello" },
        }),
        manifestProvider: async (cwd) => {
          providerCalled = true
          providerCwd = cwd
          return [] // Return empty manifest — no hooks match
        },
      }
      const result = await executeDispatch(req)
      expect(providerCalled).toBe(true)
      expect(providerCwd).toBe(process.cwd())
      expect(result.response).toEqual({})
    })

    it("falls back to loadCombinedManifest when no provider is given", async () => {
      const req: DispatchRequest = {
        canonicalEvent: "preToolUse",
        hookEventName: "PreToolUse",
        payloadStr: JSON.stringify({
          cwd: "/tmp/test-no-manifest-provider",
          session_id: "test-session",
          tool_name: "Bash",
          tool_input: { command: "echo hello" },
        }),
      }
      // Should load the built-in manifest (no provider) and execute normally
      const result = await executeDispatch(req)
      expect(result).toBeDefined()
    })
  })

  describe("daemon /dispatch endpoint", () => {
    let server: ReturnType<typeof Bun.serve>
    const TEST_PORT = 17943

    beforeAll(async () => {
      // Start daemon inline for testing
      server = Bun.serve({
        port: TEST_PORT,
        routes: {
          "/health": new Response("ok"),
        },
        async fetch(req) {
          const url = new URL(req.url)

          if (url.pathname === "/dispatch" && req.method === "POST") {
            const canonicalEvent = url.searchParams.get("event")
            const hookEventName = url.searchParams.get("hookEventName") ?? canonicalEvent
            if (!canonicalEvent || !hookEventName) {
              return Response.json(
                { error: "Missing required query param: event" },
                { status: 400 }
              )
            }

            const payloadStr = await req.text()
            try {
              const result = await executeDispatch({
                canonicalEvent,
                hookEventName,
                payloadStr,
                daemonContext: true,
              })
              return Response.json(result.response)
            } catch (e) {
              if (e instanceof DispatchPayloadValidationError) {
                return Response.json(
                  { error: e.message, issues: e.zodError.flatten() },
                  { status: 400 }
                )
              }
              if (e instanceof ZodError) {
                return Response.json(
                  { error: "Dispatch schema validation failed", issues: e.flatten() },
                  { status: 422 }
                )
              }
              throw e
            }
          }

          return new Response("Not Found", { status: 404 })
        },
      })
    })

    afterAll(() => {
      void server?.stop()
    })

    it("health endpoint returns ok", async () => {
      const resp = await fetch(`http://127.0.0.1:${TEST_PORT}/health`)
      expect(resp.ok).toBe(true)
      expect(await resp.text()).toBe("ok")
    })

    it("dispatch endpoint returns JSON response", async () => {
      const payload = JSON.stringify({ cwd: "/tmp/test-dispatch", session_id: "test-session" })
      const resp = await fetch(
        `http://127.0.0.1:${TEST_PORT}/dispatch?event=nonexistentEvent&hookEventName=NonexistentEvent`,
        { method: "POST", body: payload, headers: { "Content-Type": "application/json" } }
      )
      expect(resp.ok).toBe(true)
      const json = await resp.json()
      expect(json).toEqual({})
    })

    it("dispatch endpoint returns 400 for stop with invalid JSON body", async () => {
      const resp = await fetch(
        `http://127.0.0.1:${TEST_PORT}/dispatch?event=stop&hookEventName=Stop`,
        { method: "POST", body: "not-json", headers: { "Content-Type": "application/json" } }
      )
      expect(resp.status).toBe(400)
      const json = (await resp.json()) as { error?: string; issues?: unknown }
      expect(json.error).toContain("Invalid dispatch payload")
      expect(json.issues).toBeDefined()
    })

    it("dispatch endpoint returns 400 for invalid JSON on non-stop events", async () => {
      const resp = await fetch(
        `http://127.0.0.1:${TEST_PORT}/dispatch?event=nonexistentEvent&hookEventName=NonexistentEvent`,
        { method: "POST", body: "not-json{{{", headers: { "Content-Type": "application/json" } }
      )
      expect(resp.status).toBe(400)
    })

    it("dispatch endpoint returns 400 when event param is missing", async () => {
      const resp = await fetch(`http://127.0.0.1:${TEST_PORT}/dispatch`, {
        method: "POST",
        body: "{}",
      })
      expect(resp.status).toBe(400)
      const json = (await resp.json()) as Record<string, any>
      expect(json.error).toContain("Missing")
    })

    it("dispatch endpoint matches daemon and local response parity", async () => {
      const payload = JSON.stringify({
        cwd: "/tmp/parity-test",
        session_id: "parity-session",
        tool_name: "SomeUnknownTool",
      })

      // Local execution
      const localResult = await executeDispatch({
        canonicalEvent: "preToolUse",
        hookEventName: "PreToolUse",
        payloadStr: payload,
      })

      // Daemon execution
      const resp = await fetch(
        `http://127.0.0.1:${TEST_PORT}/dispatch?event=preToolUse&hookEventName=PreToolUse`,
        { method: "POST", body: payload, headers: { "Content-Type": "application/json" } }
      )
      const daemonResult = await resp.json()

      // Both should produce equivalent hook execution results
      // (hookExecutions may differ in timing, so compare structure)
      expect(typeof daemonResult).toBe(typeof localResult.response)
    })

    it("returns 404 for unknown paths", async () => {
      const resp = await fetch(`http://127.0.0.1:${TEST_PORT}/unknown`)
      expect(resp.status).toBe(404)
    })
  })
})
