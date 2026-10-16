import { expect, test } from "bun:test"
import { withProviderFallback } from "./ai-provider-fallback.ts"

test("falls back in order using the same signal", async () => {
  const calls: string[] = []
  const signals: AbortSignal[] = []
  const result = await withProviderFallback(
    ["first", "second", "unused"],
    async (provider, signal) => {
      calls.push(provider)
      signals.push(signal)
      if (provider === "first") throw new Error("unavailable")
      return "answer"
    },
    { timeout: 1000 }
  )
  expect(result).toBe("answer")
  expect(calls).toEqual(["first", "second"])
  expect(signals[0]).toBe(signals[1])
})

test("preserves the final provider error", async () => {
  const failure = new Error("last failure")
  await expect(
    withProviderFallback([1, 2], async (provider) => {
      throw provider === 2 ? failure : new Error("first failure")
    })
  ).rejects.toBe(failure)
})

test("does not start providers when already cancelled", async () => {
  const controller = new AbortController()
  controller.abort()
  let calls = 0
  await expect(
    withProviderFallback([1], async () => ++calls, { signal: controller.signal })
  ).rejects.toThrow("aborted")
  expect(calls).toBe(0)
})

test.each([
  false,
  true,
])("cancellation prevents fallback and late success (throws=%s)", async (throws) => {
  const controller = new AbortController()
  const calls: number[] = []
  await expect(
    withProviderFallback(
      [1, 2],
      async (provider) => {
        calls.push(provider)
        controller.abort()
        if (throws) throw new Error("backend failure")
        return "late result"
      },
      { signal: controller.signal }
    )
  ).rejects.toThrow("aborted")
  expect(calls).toEqual([1])
})

test("one timeout cancels the fallback attempt", async () => {
  const calls: number[] = []
  await expect(
    withProviderFallback(
      [1, 2, 3],
      async (provider, signal) => {
        calls.push(provider)
        if (provider === 1) throw new Error("unavailable")
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true })
        })
        return "late result"
      },
      { timeout: 20 }
    )
  ).rejects.toThrow("aborted")
  expect(calls).toEqual([1, 2])
})
