import { describe, expect, it } from "bun:test"
import { createSingleFlight, snapshotChanged } from "./dashboard-hooks.ts"

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

describe("snapshotChanged", () => {
  it("applies the first snapshot and suppresses an identical repeat", () => {
    // #856: task slices had no guard, so a 2s poll handed React a new array identity
    // for unchanged content roughly 30 times a minute.
    const holder = { current: "" }
    expect(snapshotChanged('[[{"id":"1"}],null]', holder)).toBe(true)
    expect(snapshotChanged('[[{"id":"1"}],null]', holder)).toBe(false)
    expect(snapshotChanged('[[{"id":"1"}],null]', holder)).toBe(false)
  })

  it("applies again when the content actually changes", () => {
    // Control: without it the suppression above would pass equally against a gate
    // that never applies anything.
    const holder = { current: "" }
    expect(snapshotChanged('[[{"id":"1"}],null]', holder)).toBe(true)
    expect(snapshotChanged('[[{"id":"2"}],null]', holder)).toBe(true)
    expect(snapshotChanged('[[{"id":"2"}],null]', holder)).toBe(false)
  })

  it("applies an identical snapshot again once the holder is cleared", () => {
    // The session-switch path. The holder is a ref that outlives the polling effect, so
    // clearing it on switch is what stops the previous selection's snapshot from
    // suppressing the new one's first update — two empty lists being the common case.
    const holder = { current: "" }
    expect(snapshotChanged("[[],null]", holder)).toBe(true)
    expect(snapshotChanged("[[],null]", holder)).toBe(false)

    holder.current = ""
    expect(snapshotChanged("[[],null]", holder)).toBe(true)
  })
})
