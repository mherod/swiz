import { describe, expect, it } from "bun:test"
import { CappedMap } from "./capped-map.ts"

describe("CappedMap", () => {
  it("stores and retrieves values within capacity", () => {
    const map = new CappedMap<string, number>(3)
    map.set("a", 1)
    map.set("b", 2)
    map.set("c", 3)

    expect(map.size).toBe(3)
    expect(map.get("a")).toBe(1)
    expect(map.get("b")).toBe(2)
    expect(map.get("c")).toBe(3)
    expect(map.has("a")).toBe(true)
    expect(map.has("d")).toBe(false)
  })

  it("evicts the least-recently-used entry when capacity is exceeded", () => {
    const map = new CappedMap<string, number>(3)
    map.set("a", 1)
    map.set("b", 2)
    map.set("c", 3)

    // Access "a" to promote it to MRU (iteration order becomes b, c, a)
    expect(map.get("a")).toBe(1)

    // Adding "d" should evict "b" (the oldest unaccessed entry)
    map.set("d", 4)

    expect(map.size).toBe(3)
    expect(map.has("b")).toBe(false)
    expect(map.has("a")).toBe(true)
    expect(map.has("c")).toBe(true)
    expect(map.has("d")).toBe(true)
    expect(Array.from(map.keys())).toEqual(["c", "a", "d"])
  })

  it("re-setting an existing key promotes it without increasing size", () => {
    const map = new CappedMap<string, number>(3)
    map.set("a", 1)
    map.set("b", 2)
    map.set("c", 3)

    // Re-set "a" -> moves to MRU
    map.set("a", 10)

    expect(map.size).toBe(3)
    map.set("d", 4) // evicts "b"

    expect(map.has("b")).toBe(false)
    expect(map.has("a")).toBe(true)
    expect(map.get("a")).toBe(10)
    expect(Array.from(map.keys())).toEqual(["c", "d", "a"])
  })

  it("retains the newest items when items are inserted in oldest-to-newest order", () => {
    const map = new CappedMap<string, number>(10)
    // 30 items from oldest (s29) to newest (s0)
    const items = Array.from({ length: 30 }, (_, i) => ({
      key: `s${29 - i}`,
      val: 29 - i,
    }))

    // Insert in oldest-to-newest order: s29, s28, ..., s0
    for (const item of items) {
      map.set(item.key, item.val)
    }

    expect(map.size).toBe(10)
    // The 10 remaining items should be the newest: s9 down to s0
    const expectedKeys = Array.from({ length: 10 }, (_, i) => `s${9 - i}`)
    expect(Array.from(map.keys())).toEqual(expectedKeys)
  })

  it("supports delete and clear operations", () => {
    const map = new CappedMap<string, number>(3)
    map.set("a", 1)
    map.set("b", 2)

    expect(map.delete("a")).toBe(true)
    expect(map.delete("a")).toBe(false)
    expect(map.size).toBe(1)

    map.clear()
    expect(map.size).toBe(0)
    expect(map.get("b")).toBeUndefined()
  })
})
