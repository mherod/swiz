import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  acquireGhSlot,
  getGhRateLimitStats,
  observeGhApiIncludeOutput,
  parseGhApiIncludeOutput,
  resetGhRateLimitStateForTests,
} from "./gh-rate-limit.ts"

function includeResponse(headers: Record<string, string>, body = '{"ok":true}'): string {
  const headerLines = Object.entries(headers).map(([name, value]) => `${name}: ${value}`)
  return ["HTTP/2 200 OK", ...headerLines, "", body].join("\r\n")
}

describe("gh-rate-limit", () => {
  let restoreSpawn = (): void => {}

  afterEach(() => {
    restoreSpawn()
  })

  beforeEach(() => {
    resetGhRateLimitStateForTests()
    restoreSpawn = () => {}
  })

  function createMockSpawn(
    stdout = "",
    stderr = "",
    exitCode = 0,
    onSpawn?: (command: string[]) => void
  ): () => void {
    const previous = Bun.spawn

    Bun.spawn = ((command: string[]) => {
      onSpawn?.(command)
      return {
        exited: Promise.resolve(),
        exitCode,
        stdout: new ReadableStream({
          start(controller) {
            if (stdout) controller.enqueue(new TextEncoder().encode(stdout))
            controller.close()
          },
        }),
        stderr: new ReadableStream({
          start(controller) {
            if (stderr) controller.enqueue(new TextEncoder().encode(stderr))
            controller.close()
          },
        }),
      } as unknown as ReturnType<typeof Bun.spawn>
    }) as typeof Bun.spawn

    return () => {
      Bun.spawn = previous
    }
  }

  test("parses gh api --include headers and body", () => {
    const parsed = parseGhApiIncludeOutput(
      includeResponse(
        {
          "X-RateLimit-Limit": "5000",
          "X-RateLimit-Remaining": "4998",
          "X-RateLimit-Reset": "2000000000",
        },
        '{"login":"mherod"}'
      )
    )

    expect(parsed.status).toBe(200)
    expect(parsed.headers["x-ratelimit-limit"]).toBe("5000")
    expect(parsed.headers["x-ratelimit-remaining"]).toBe("4998")
    expect(parsed.body).toBe('{"login":"mherod"}')
  })

  test("observeGhApiIncludeOutput updates stats from real GitHub headers", async () => {
    const body = observeGhApiIncludeOutput(
      includeResponse({
        "X-RateLimit-Limit": "5000",
        "X-RateLimit-Remaining": "4321",
        "X-RateLimit-Reset": "2000000000",
      })
    )

    expect(body).toBe('{"ok":true}')
    const stats = await getGhRateLimitStats()
    expect(stats).toEqual({ used: 679, limit: 5000, remaining: 4321 })
  })

  test("acquireGhSlot uses an in-memory budget on cold start", async () => {
    const calls: string[][] = []
    restoreSpawn = createMockSpawn(
      includeResponse(
        {
          "X-RateLimit-Limit": "5000",
          "X-RateLimit-Remaining": "5000",
          "X-RateLimit-Reset": "2000000000",
        },
        "{}"
      ),
      "",
      0,
      (command) => calls.push(command)
    )

    await acquireGhSlot()

    const stats = await getGhRateLimitStats()
    expect(calls).toHaveLength(1)
    expect(calls[0]![0]).toBe("gh")
    expect(calls[0]).toContain("rate_limit")
    expect(stats.limit).toBe(5000)
    expect(stats.used).toBe(1)
    expect(stats.remaining).toBe(4999)
  })

  test("honors short Retry-After before consuming the next slot", async () => {
    const reset = Math.ceil((Date.now() + 1000) / 1000)
    observeGhApiIncludeOutput(
      includeResponse({
        "Retry-After": "0",
        "X-RateLimit-Limit": "5000",
        "X-RateLimit-Remaining": "1",
        "X-RateLimit-Reset": String(reset),
      })
    )

    await acquireGhSlot()

    expect(await getGhRateLimitStats()).toEqual({ used: 5000, limit: 5000, remaining: 0 })
  })

  test("falls back to optimistic budget when bootstrap headers are unavailable", async () => {
    restoreSpawn = createMockSpawn("{}", "", 0)

    await acquireGhSlot()
    const stats = await getGhRateLimitStats()

    expect(stats).toEqual({ used: 1, limit: 5000, remaining: 4999 })
  })

  test("does not call /rate_limit repeatedly while budget is valid", async () => {
    let calls = 0
    restoreSpawn = createMockSpawn(includeResponse({}, "{}"), "", 0, () => {
      calls += 1
    })

    await acquireGhSlot()
    await acquireGhSlot()
    expect(calls).toBe(1)
  })
})
