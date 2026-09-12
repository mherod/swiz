import { describe, expect, test } from "bun:test"
import qualityHook from "../../hooks/stop-quality-checks.ts"
import type { HookGroup } from "../manifest.ts"
import { runEntry } from "./engine.ts"
import { stopCollectionTimeoutMs } from "./strategy-base.ts"

describe("quality-check dispatch budgets", () => {
  test("collects a synchronous quality result through its declared deadline", () => {
    const groups: HookGroup[] = [{ event: "stop", hooks: [{ hook: qualityHook }] }]
    expect(stopCollectionTimeoutMs(groups, 10_000)).toBe(120_000)
    expect(
      stopCollectionTimeoutMs(
        [{ event: "stop", hooks: [{ file: "long-check.ts", timeout: 999 }] }],
        10_000
      )
    ).toBe(180_000)
  })

  test("fire-and-forget hooks do not extend the collection window", () => {
    expect(
      stopCollectionTimeoutMs(
        [{ event: "stop", hooks: [{ file: "background.ts", timeout: 180, async: true }] }],
        10_000
      )
    ).toBe(10_000)
  })

  test("passes the effective timeout and live cancellation signal to inline hooks", async () => {
    const controller = new AbortController()
    const result = await runEntry(
      {
        matcher: undefined,
        hook: {
          hook: {
            name: "quality-context-test",
            event: "stop",
            timeout: 120,
            async run(_input, context) {
              expect(context?.timeoutMs).toBe(120_000)
              expect(context?.signal).toBe(controller.signal)
              controller.abort()
              expect(context?.signal?.aborted).toBe(true)
              return { decision: "block", reason: "Verification cancelled; unverified" }
            },
          },
        },
      },
      JSON.stringify({ cwd: process.cwd(), session_id: "quality-context-test" }),
      process.cwd(),
      controller.signal
    )
    expect(result.parsed?.decision).toBe("block")
    expect(result.parsed?.reason).toContain("unverified")
  })
})
