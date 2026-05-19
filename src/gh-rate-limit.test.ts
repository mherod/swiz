import { beforeEach, describe, expect, test } from "bun:test"
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
  beforeEach(() => {
    resetGhRateLimitStateForTests()
  })

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
    await acquireGhSlot()

    const stats = await getGhRateLimitStats()
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
})
