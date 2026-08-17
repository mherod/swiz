import { describe, expect, it } from "bun:test"
import { createSingleFlight } from "./dashboard-hooks.ts"

describe("dashboard polling", () => {
  it("coalesces overlapping polls and permits a later refresh", async () => {
    let calls = 0
    let release: (() => void) | undefined
    const poll = createSingleFlight(async () => {
      calls++
      await new Promise<void>((resolve) => {
        release = resolve
      })
    })

    const first = poll()
    const overlapping = poll()
    expect(calls).toBe(1)
    release?.()
    await Promise.all([first, overlapping])

    const later = poll()
    expect(calls).toBe(2)
    release?.()
    await later
  })
})
