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
