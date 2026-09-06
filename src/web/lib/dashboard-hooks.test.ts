import { describe, expect, it } from "bun:test"
import { createSingleFlight, revisionChanged, snapshotChanged } from "./dashboard-hooks.ts"

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

describe("transcript revision comparison", () => {
  it("reports the first revision as changed so the initial transcript renders", () => {
    const holder = { current: undefined as string | undefined }
    expect(revisionChanged("rev-1", holder)).toBe(true)
  })

  it("reports an unchanged revision without inspecting the messages", () => {
    const holder = { current: undefined as string | undefined }
    expect(revisionChanged("rev-1", holder)).toBe(true)
    expect(revisionChanged("rev-1", holder)).toBe(false)
    expect(revisionChanged("rev-1", holder)).toBe(false)
  })

  it("reports a changed revision promptly", () => {
    const holder = { current: undefined as string | undefined }
    revisionChanged("rev-1", holder)
    expect(revisionChanged("rev-2", holder)).toBe(true)
    // And settles again on the new value.
    expect(revisionChanged("rev-2", holder)).toBe(false)
  })

  it("returns undefined for a response without a revision so the caller falls back", () => {
    // Older daemons send no revision. Reading that as "unchanged" would freeze the transcript,
    // so the contract is an explicit undefined rather than false.
    const holder = { current: undefined as string | undefined }
    expect(revisionChanged(undefined, holder)).toBeUndefined()

    // Control: a real revision on the same holder still reports a change.
    expect(revisionChanged("rev-1", holder)).toBe(true)
  })

  it("keeps falling back after a server downgrade mid-session", () => {
    const holder = { current: undefined as string | undefined }
    expect(revisionChanged("rev-1", holder)).toBe(true)
    expect(revisionChanged(undefined, holder)).toBeUndefined()
    // The retained revision must not resurrect: the next revisioned poll is judged against it.
    expect(revisionChanged("rev-1", holder)).toBe(false)
    expect(revisionChanged("rev-2", holder)).toBe(true)
  })

  it("compares in constant time regardless of transcript size", () => {
    // The point of the revision: cost is one string comparison, not a walk of the viewport.
    const holder = { current: undefined as string | undefined }
    const big = "rev-".concat("x".repeat(64))
    expect(revisionChanged(big, holder)).toBe(true)
    expect(revisionChanged(big, holder)).toBe(false)
  })
})
