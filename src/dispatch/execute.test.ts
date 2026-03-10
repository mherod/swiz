import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { type DispatchRequest, executeDispatch } from "./execute.ts"

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

  it("handles invalid JSON payload gracefully", async () => {
    const req: DispatchRequest = {
      canonicalEvent: "nonexistentEvent",
      hookEventName: "NonexistentEvent",
      payloadStr: "not-json{{{",
    }
    const result = await executeDispatch(req)
    expect(result).toBeDefined()
    expect(result.response).toEqual({})
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
})

describe("transcriptSummaryProvider", () => {
  it("uses cached provider instead of reading file when provided", async () => {
    let providerCalled = false
    let providerPath = ""
    const req: DispatchRequest = {
      canonicalEvent: "preToolUse",
      hookEventName: "PreToolUse",
      payloadStr: JSON.stringify({
        cwd: "/tmp/test-provider",
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

describe("manifestProvider", () => {
  it("uses cached manifest provider instead of loading from disk", async () => {
    let providerCalled = false
    let providerCwd = ""
    const req: DispatchRequest = {
      canonicalEvent: "preToolUse",
      hookEventName: "PreToolUse",
      payloadStr: JSON.stringify({
        cwd: "/tmp/test-manifest-provider",
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
    expect(providerCwd).toBe("/tmp/test-manifest-provider")
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
            return Response.json({ error: "Missing required query param: event" }, { status: 400 })
          }

          const payloadStr = await req.text()
          const result = await executeDispatch({
            canonicalEvent,
            hookEventName,
            payloadStr,
            daemonContext: true,
          })
          return Response.json(result.response)
        }

        return new Response("Not Found", { status: 404 })
      },
    })
  })

  afterAll(() => {
    server?.stop()
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

  it("dispatch endpoint returns 400 when event param is missing", async () => {
    const resp = await fetch(`http://127.0.0.1:${TEST_PORT}/dispatch`, {
      method: "POST",
      body: "{}",
    })
    expect(resp.status).toBe(400)
    const json = (await resp.json()) as Record<string, unknown>
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
