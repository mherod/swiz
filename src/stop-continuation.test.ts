import { expect, mock, test } from "bun:test"
import { resolveStopContinuationMode } from "./stop-continuation.ts"

test("five-minute boundary permits delivery only and resets when activity resumes", async () => {
  const settings = { autoContinue: false, idleDeliveryMinutes: 5 }
  const idle = mock(async () => 299.999)
  expect(await resolveStopContinuationMode(settings, idle)).toBe("commit")
  idle.mockResolvedValue(300)
  expect(await resolveStopContinuationMode(settings, idle)).toBe("delivery")
  idle.mockResolvedValue(0)
  expect(await resolveStopContinuationMode(settings, idle)).toBe("commit")
})

test("explicit auto-continue and disabled idle mode do not probe hardware", async () => {
  const idle = mock(async () => 1000)
  expect(
    await resolveStopContinuationMode({ autoContinue: true, idleDeliveryMinutes: 5 }, idle)
  ).toBe("all")
  expect(
    await resolveStopContinuationMode({ autoContinue: false, idleDeliveryMinutes: 0 }, idle)
  ).toBe("commit")
  expect(idle).not.toHaveBeenCalled()
})

test("unknown, invalid, and failed input readings never enable continuation", async () => {
  const settings = { autoContinue: false, idleDeliveryMinutes: 5 }
  for (const value of [null, Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    expect(await resolveStopContinuationMode(settings, async () => value)).toBe("commit")
  }
  expect(
    await resolveStopContinuationMode(settings, async () => {
      throw new Error("probe failed")
    })
  ).toBe("commit")
})
