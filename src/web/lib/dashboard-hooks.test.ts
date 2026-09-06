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

  it("keeps a volatile field from dragging unrelated slices, once each slice owns a holder", () => {
    // #856: /metrics carries a fresh uptimeMs every poll, and the overview path compared
    // all five slices as one string — so an unchanged watches payload was marked changed
    // 30 times a minute purely because the clock moved.
    const metrics = () => ({ uptimeMs: 0 })
    const watches = { active: ["ci-1"] }

    // The old shape: one holder over the whole batch.
    const combined = { current: "" }
    expect(snapshotChanged(JSON.stringify({ m: { uptimeMs: 1 }, w: watches }), combined)).toBe(true)
    expect(snapshotChanged(JSON.stringify({ m: { uptimeMs: 2 }, w: watches }), combined)).toBe(true)

    // Per-slice holders: watches is stable across the same two ticks, metrics still moves.
    const watchesHolder = { current: "" }
    const metricsHolder = { current: "" }
    expect(snapshotChanged(JSON.stringify(watches), watchesHolder)).toBe(true)
    expect(snapshotChanged(JSON.stringify(watches), watchesHolder)).toBe(false)
    expect(snapshotChanged(JSON.stringify({ ...metrics(), uptimeMs: 1 }), metricsHolder)).toBe(true)
    expect(snapshotChanged(JSON.stringify({ ...metrics(), uptimeMs: 2 }), metricsHolder)).toBe(true)
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
