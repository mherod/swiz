import { describe, expect, test } from "bun:test"
import qualityHook from "../../hooks/stop-quality-checks.ts"
import type { HookGroup } from "../manifest.ts"
import { runEntry } from "./engine.ts"
import { stopCollectionTimeoutMs } from "./strategy-base.ts"
import { DISPATCH_BUDGET_SEC, DISPATCH_TIMEOUTS } from "./timeouts.ts"
import { HOOK_TIMEOUT_CAP_SEC, resolveHookTimeoutSec, SIGKILL_GRACE_MS } from "./worker-types.ts"

describe("quality-check dispatch budgets", () => {
  test("no declared hook budget extends collection past the event budget", () => {
    const eventBudgetMs = DISPATCH_BUDGET_SEC * 1000
    const groups: HookGroup[] = [{ event: "stop", hooks: [{ hook: qualityHook }] }]
    expect(stopCollectionTimeoutMs(groups, 10_000)).toBe(eventBudgetMs)
    expect(
      stopCollectionTimeoutMs(
        [{ event: "stop", hooks: [{ file: "long-check.ts", timeout: 999 }] }],
        10_000
      )
    ).toBe(eventBudgetMs)
  })

  test("a long declared timeout is capped before it sets the collection window", () => {
    // Control: below the event budget the window follows the capped hook budget, not 999s.
    expect(
      stopCollectionTimeoutMs(
        [{ event: "stop", hooks: [{ file: "long-check.ts", timeout: 999 }] }],
        1_000
      )
    ).toBe(HOOK_TIMEOUT_CAP_SEC * 1000)
  })

  test("fire-and-forget hooks do not extend the collection window", () => {
    expect(
      stopCollectionTimeoutMs(
        [{ event: "stop", hooks: [{ file: "background.ts", timeout: 180, async: true }] }],
        2_000
      )
    ).toBe(2_000)
  })

  test("the event budget covers the hook cap plus its kill grace", () => {
    expect(DISPATCH_BUDGET_SEC * 1000).toBeGreaterThanOrEqual(
      HOOK_TIMEOUT_CAP_SEC * 1000 + SIGKILL_GRACE_MS
    )
    for (const seconds of Object.values(DISPATCH_TIMEOUTS)) {
      expect(seconds).toBe(DISPATCH_BUDGET_SEC)
    }
  })

  test("passes the capped timeout and live cancellation signal to inline hooks", async () => {
    const controller = new AbortController()
    const cappedMs = resolveHookTimeoutSec(120) * 1000
    expect(cappedMs).toBe(HOOK_TIMEOUT_CAP_SEC * 1000)
    const result = await runEntry(
      {
        matcher: undefined,
        hook: {
          hook: {
            name: "quality-context-test",
            event: "stop",
            timeout: 120,
            async run(_input, context) {
              expect(context?.timeoutMs).toBe(cappedMs)
              // Control: the signal is live, not already aborted, before the dispatch cancels.
              expect(context?.signal?.aborted).toBe(false)
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
