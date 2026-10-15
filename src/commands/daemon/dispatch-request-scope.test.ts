import { describe, expect, spyOn, test } from "bun:test"
import { type DispatchRequestScope, withDispatchRequestScope } from "./dispatch-request-scope.ts"

describe("dispatch request scope", () => {
  test("bounds preparation and completion with one shrinking budget", async () => {
    const caller = new AbortController()
    let scope!: DispatchRequestScope
    const result = await withDispatchRequestScope(caller.signal, 10, async (current) => {
      scope = current
      expect(current.remainingMs()).toBeGreaterThan(0)
      expect(current.remainingMs()).toBeLessThanOrEqual(10)
      return new Promise<never>(() => {})
    })
    expect(result).toEqual({ kind: "timeout" })
    expect(scope.signal.aborted).toBe(true)
    expect(scope.remainingMs()).toBe(0)
  })

  test("cancellation settles even when work ignores its signal", async () => {
    const caller = new AbortController()
    let release!: (value: number) => void
    let scope!: DispatchRequestScope
    const pending = withDispatchRequestScope(caller.signal, 60_000, async (current) => {
      scope = current
      return new Promise<number>((resolve) => {
        release = resolve
      })
    })
    caller.abort()
    expect(await pending).toEqual({ kind: "aborted" })
    expect(scope.signal.aborted).toBe(true)
    release(42)
    expect(await pending).toEqual({ kind: "aborted" })
  })

  test("removes caller listeners after success and failure", async () => {
    const caller = new AbortController()
    const add = spyOn(caller.signal, "addEventListener")
    const remove = spyOn(caller.signal, "removeEventListener")
    try {
      expect(await withDispatchRequestScope(caller.signal, 60_000, async () => 42)).toEqual({
        kind: "completed",
        value: 42,
      })
      await expect(
        withDispatchRequestScope(caller.signal, 60_000, async () => {
          throw new Error("failed preparation")
        })
      ).rejects.toThrow("failed preparation")
      expect(add).toHaveBeenCalledTimes(2)
      expect(remove.mock.calls.map((call) => call.slice(0, 2))).toEqual(
        add.mock.calls.map((call) => call.slice(0, 2))
      )
    } finally {
      add.mockRestore()
      remove.mockRestore()
    }
  })
})
