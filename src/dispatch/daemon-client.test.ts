import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  daemonDispatchPolicy,
  enrichDispatchPayload,
  resetDaemonBackoff,
  tryDaemonDispatch,
} from "./daemon-client.ts"
import {
  DISPATCH_TIMEOUTS,
  dispatchTimeoutSeconds,
  HOOK_CONTEXT_HUMANISE_TIMEOUT_MS,
} from "./timeouts.ts"

const envKeys = [
  "SWIZ_NO_DAEMON",
  "SWIZ_DAEMON_PORT",
  "AI_TEST_NO_BACKEND",
  "TERM_PROGRAM",
  "SWIZ_CLIENT_TEST_CONTEXT",
  "CODEX_CLIENT_TEST_CONTEXT",
  "CURSOR_CLIENT_TEST_CONTEXT",
  "GEMINI_CLIENT_TEST_CONTEXT",
  "ANTHROPIC_CLIENT_TEST_CONTEXT",
  "CLIENT_TEST_UNRELATED",
] as const
const originalEnv = new Map(envKeys.map((key) => [key, process.env[key]]))

beforeEach(() => {
  process.env.AI_TEST_NO_BACKEND = "1"
  process.env.SWIZ_NO_DAEMON = ""
  resetDaemonBackoff()
})

afterEach(() => {
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  resetDaemonBackoff()
})

function respond(response: Response): () => Promise<Response> {
  return async () => response
}

describe("shared daemon transport", () => {
  test("sends the original payload and event names and returns the daemon envelope", async () => {
    const received: {
      method: string
      event: string | null
      hook: string | null
      body: string
    }[] = []
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url)
        received.push({
          method: req.method,
          event: url.searchParams.get("event"),
          hook: url.searchParams.get("hookEventName"),
          body: await req.text(),
        })
        return Response.json({ decision: "block", reason: "fixture reason" })
      },
    })
    process.env.SWIZ_DAEMON_PORT = String(server.port)
    const payload = JSON.stringify({ cwd: "/fixture", tool_input: { command: "echo fixture" } })
    try {
      const result = await tryDaemonDispatch("pre Tool/Use", "Pre Tool & Use", payload, {
        timeoutMs: 1000,
      })
      expect(result).toEqual({
        kind: "response",
        response: { decision: "block", reason: "fixture reason" },
      })
      expect(received).toEqual([
        {
          method: "POST",
          event: "pre Tool/Use",
          hook: "Pre Tool & Use",
          body: payload,
        },
      ])
    } finally {
      await server.stop(true)
    }
  })

  test("the deadline covers a response body that stalls after successful headers", async () => {
    let bodyStarted = false
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(
          new ReadableStream({
            start(controller) {
              bodyStarted = true
              controller.enqueue(new TextEncoder().encode('{"reason":'))
            },
          }),
          { headers: { "Content-Type": "application/json" } }
        )
      },
    })
    process.env.SWIZ_DAEMON_PORT = String(server.port)
    try {
      const result = await tryDaemonDispatch("preToolUse", "PreToolUse", "{}", { timeoutMs: 250 })
      expect(bodyStarted).toBe(true)
      expect(result).toEqual({ kind: "timeout" })
    } finally {
      await server.stop(true)
    }
  })

  test("a request that never receives headers reports timeout", async () => {
    const pending = Promise.withResolvers<Response>()
    const server = Bun.serve({ port: 0, fetch: () => pending.promise })
    process.env.SWIZ_DAEMON_PORT = String(server.port)
    try {
      expect(await tryDaemonDispatch("stop", "Stop", "{}", { timeoutMs: 25 })).toEqual({
        kind: "timeout",
      })
    } finally {
      pending.resolve(Response.json({}))
      await server.stop(true)
    }
  })

  test.each([
    [200, "response"],
    [503, "unavailable"],
    [504, "timeout"],
  ] as const)("HTTP %i is classified as %s", async (status, kind) => {
    const result = await tryDaemonDispatch("stop", "Stop", "{}", {
      fetch: respond(Response.json({}, { status })),
    })
    expect(result.kind).toBe(kind)
  })

  test("transport failure and malformed JSON are unavailable rather than timeout", async () => {
    const failingFetch = async () => {
      throw new Error("fixture connection failed")
    }
    expect(await tryDaemonDispatch("stop", "Stop", "{}", { fetch: failingFetch })).toEqual({
      kind: "unavailable",
    })
    resetDaemonBackoff()
    expect(
      await tryDaemonDispatch("stop", "Stop", "{}", {
        fetch: respond(new Response("invalid JSON")),
      })
    ).toEqual({ kind: "unavailable" })
  })

  test("failure backoff suppresses requests until explicitly reset", async () => {
    let calls = 0
    const send = async () => {
      calls++
      return calls === 1 ? new Response("unavailable", { status: 503 }) : Response.json({})
    }
    expect((await tryDaemonDispatch("preToolUse", "PreToolUse", "{}", { fetch: send })).kind).toBe(
      "unavailable"
    )
    expect((await tryDaemonDispatch("preToolUse", "PreToolUse", "{}", { fetch: send })).kind).toBe(
      "unavailable"
    )
    expect(calls).toBe(1)
    resetDaemonBackoff()
    expect((await tryDaemonDispatch("preToolUse", "PreToolUse", "{}", { fetch: send })).kind).toBe(
      "response"
    )
    expect(calls).toBe(2)
  })

  test("SWIZ_NO_DAEMON skips transport", async () => {
    process.env.SWIZ_NO_DAEMON = "1"
    let calls = 0
    const send = async () => {
      calls++
      return Response.json({})
    }
    expect(await tryDaemonDispatch("stop", "Stop", "{}", { fetch: send })).toEqual({
      kind: "unavailable",
    })
    expect(calls).toBe(0)
  })

  test.each([
    [undefined, 7943],
    ["not-a-number", 7943],
    ["0", 7943],
    ["-2", 7943],
    ["9123", 9123],
  ] as const)("port setting %s selects %i", async (configured, expected) => {
    if (configured === undefined) delete process.env.SWIZ_DAEMON_PORT
    else process.env.SWIZ_DAEMON_PORT = configured
    let url = ""
    const send = async (input: string) => {
      url = String(input)
      return Response.json({})
    }
    await tryDaemonDispatch("stop", "Stop", "{}", { fetch: send })
    expect(new URL(url).origin).toBe(`http://127.0.0.1:${expected}`)
  })
})

describe("dispatch fallback policy", () => {
  test("Stop events retain local checks after timeout", () => {
    expect(daemonDispatchPolicy("stop")).toEqual({
      timeoutMs: dispatchTimeoutSeconds("stop") * 1000 - 3000,
      timeoutFallback: "local",
    })
    expect(daemonDispatchPolicy("subagentStop").timeoutFallback).toBe("local")
  })

  test("other events allow after timeout with client headroom", () => {
    for (const [event, seconds] of Object.entries(DISPATCH_TIMEOUTS)) {
      if (event === "stop") continue
      const policy = daemonDispatchPolicy(event)
      expect(policy.timeoutFallback).toBe("allow")
      expect(policy.timeoutMs).toBe(seconds * 1000 - 3000 + HOOK_CONTEXT_HUMANISE_TIMEOUT_MS)
      expect(policy.timeoutMs).toBeLessThan(dispatchTimeoutSeconds(event) * 1000)
    }
    expect(daemonDispatchPolicy("unknownEvent")).toEqual({
      timeoutMs: 42_000,
      timeoutFallback: "allow",
    })
  })
})

describe("dispatch payload enrichment", () => {
  test("captures supported environment and terminal context without unrelated variables", () => {
    process.env.TERM_PROGRAM = "WezTerm"
    for (const prefix of ["SWIZ", "CODEX", "CURSOR", "GEMINI", "ANTHROPIC"]) {
      process.env[`${prefix}_CLIENT_TEST_CONTEXT`] = "fixture-context"
    }
    process.env.CLIENT_TEST_UNRELATED = "unrelated-fixture"
    const payload: Record<string, any> = { cwd: "/fixture" }
    enrichDispatchPayload(payload, "codex", performance.now())
    expect(payload._terminal).toEqual({ app: "wezterm", name: "WezTerm" })
    for (const prefix of ["SWIZ", "CODEX", "CURSOR", "GEMINI", "ANTHROPIC"]) {
      expect(payload._env[`${prefix}_CLIENT_TEST_CONTEXT`]).toBe("fixture-context")
    }
    expect(Object.hasOwn(payload._env, "CLIENT_TEST_UNRELATED")).toBe(false)
    expect(payload._agent).toBe("codex")
    expect(payload._swizTiming.cliBootstrapMs).toBeGreaterThanOrEqual(0)
    expect(payload.cwd).toBe("/fixture")
  })

  test("preserves caller-supplied enrichment and timing when no new start time is supplied", () => {
    const env = { SWIZ_CLIENT_TEST_CONTEXT: "already-captured" }
    const terminal = { app: "fixture-terminal", name: "Fixture terminal" }
    const timing = { cliBootstrapMs: 12 }
    const payload = { _env: env, _terminal: terminal, _agent: "claude", _swizTiming: timing }
    enrichDispatchPayload(payload, "codex")
    expect(payload._env).toBe(env)
    expect(payload._terminal).toBe(terminal)
    expect(payload._agent).toBe("claude")
    expect(payload._swizTiming).toBe(timing)
  })
})
