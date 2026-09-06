import { describe, expect, test } from "bun:test"
import { PendingRequestRegistry } from "./worker-rpc.ts"

describe("PendingRequestRegistry", () => {
  test("settles a request when its reply arrives and releases the entry", async () => {
    const registry = new PendingRequestRegistry()
    const id = registry.nextId("manifest")

    const promise = registry.register<string[]>(id)
    expect(registry.pendingCount).toBe(1)
    expect(registry.has(id)).toBe(true)

    expect(registry.resolve(id, ["group-a"])).toBe(true)
    await expect(promise).resolves.toEqual(["group-a"])

    expect(registry.pendingCount).toBe(0)
    expect(registry.has(id)).toBe(false)
    expect(registry.getMetrics()).toEqual({ pending: 0, timeouts: 0, failures: 0 })
  })

  test("rejects a stalled request once its deadline expires", async () => {
    const registry = new PendingRequestRegistry()
    const id = registry.nextId("metrics")

    const promise = registry.register(id, { timeoutMs: 20, label: "dispatchConcurrencyMetrics" })

    await expect(promise).rejects.toThrow(
      "Worker request timed out after 20ms: dispatchConcurrencyMetrics"
    )
    // The entry and its timer are gone, so a stalled request cannot leak.
    expect(registry.pendingCount).toBe(0)
    expect(registry.getMetrics()).toEqual({ pending: 0, timeouts: 1, failures: 1 })
  })

  test("applies the registry default deadline when a request specifies none", async () => {
    const registry = new PendingRequestRegistry({ defaultTimeoutMs: 15 })

    await expect(registry.register(registry.nextId("init"), { label: "init" })).rejects.toThrow(
      "timed out after 15ms: init"
    )
    expect(registry.getMetrics().timeouts).toBe(1)
  })

  test("rejects with the peer's structured error instead of waiting for the deadline", async () => {
    const registry = new PendingRequestRegistry()
    const id = registry.nextId("settings")

    const promise = registry.register(id, { timeoutMs: 60_000 })
    expect(registry.reject(id, new Error("Transcript monitor is not initialized"))).toBe(true)

    await expect(promise).rejects.toThrow("Transcript monitor is not initialized")
    expect(registry.pendingCount).toBe(0)
    expect(registry.getMetrics()).toEqual({ pending: 0, timeouts: 0, failures: 1 })
  })

  test("rejects every pending request when the worker is lost", async () => {
    const registry = new PendingRequestRegistry()
    const first = registry.register(registry.nextId("check"), { timeoutMs: 60_000 })
    const second = registry.register(registry.nextId("check"), { timeoutMs: 60_000 })
    const third = registry.register(registry.nextId("metrics"), { timeoutMs: 60_000 })

    expect(registry.pendingCount).toBe(3)
    expect(registry.rejectAll("Worker exited with code 1")).toBe(3)

    await expect(first).rejects.toThrow("Worker exited with code 1")
    await expect(second).rejects.toThrow("Worker exited with code 1")
    await expect(third).rejects.toThrow("Worker exited with code 1")

    expect(registry.pendingCount).toBe(0)
    expect(registry.getMetrics()).toEqual({ pending: 0, timeouts: 0, failures: 3 })
  })

  test("aborts a request cooperatively through its signal", async () => {
    const registry = new PendingRequestRegistry()
    const controller = new AbortController()
    const id = registry.nextId("check")

    const promise = registry.register(id, {
      timeoutMs: 60_000,
      signal: controller.signal,
      label: "checkProject",
    })
    expect(registry.pendingCount).toBe(1)

    controller.abort()

    await expect(promise).rejects.toThrow("Worker request aborted: checkProject")
    expect(registry.pendingCount).toBe(0)
    expect(registry.getMetrics()).toEqual({ pending: 0, timeouts: 0, failures: 1 })
  })

  test("rejects immediately when registered with an already-aborted signal", async () => {
    const registry = new PendingRequestRegistry()
    const controller = new AbortController()
    controller.abort()

    const promise = registry.register(registry.nextId("check"), {
      signal: controller.signal,
      label: "checkProject",
    })

    await expect(promise).rejects.toThrow("Worker request aborted before dispatch: checkProject")
    // Never registered, so nothing to clean up.
    expect(registry.pendingCount).toBe(0)
  })

  test("keeps the first settlement when a late reply, timeout, and abort race", async () => {
    const registry = new PendingRequestRegistry()
    const controller = new AbortController()
    const id = registry.nextId("check")

    const promise = registry.register<string>(id, {
      timeoutMs: 60_000,
      signal: controller.signal,
    })
    registry.resolve(id, "first")

    // Every later settlement attempt is a no-op against an already-released entry.
    expect(registry.resolve(id, "second")).toBe(false)
    expect(registry.reject(id, new Error("late error"))).toBe(false)
    controller.abort()
    expect(registry.rejectAll("worker exited")).toBe(0)

    await expect(promise).resolves.toBe("first")
    expect(registry.getMetrics()).toEqual({ pending: 0, timeouts: 0, failures: 0 })
  })

  test("issues monotonic ids so concurrent requests never collide", () => {
    const registry = new PendingRequestRegistry()
    const ids = new Set<string>()
    for (let i = 0; i < 1000; i++) {
      ids.add(registry.nextId("check"))
    }
    expect(ids.size).toBe(1000)
    expect(registry.nextId("metrics")).toBe("metrics-1000")
  })

  test("refuses a duplicate id rather than orphaning the earlier resolver", async () => {
    const registry = new PendingRequestRegistry()
    const first = registry.register<string>("dup", { timeoutMs: 60_000 })
    const second = registry.register("dup", { timeoutMs: 60_000 })

    await expect(second).rejects.toThrow("Duplicate worker request id: dup")

    // The original request is untouched and still settles normally.
    expect(registry.resolve("dup", "original")).toBe(true)
    await expect(first).resolves.toBe("original")
  })

  test("resumes cleanly after a bulk rejection so later requests still settle", async () => {
    const registry = new PendingRequestRegistry()
    const stranded = registry.register(registry.nextId("check"), { timeoutMs: 60_000 })
    registry.rejectAll("Worker exited with code 1")
    await expect(stranded).rejects.toThrow("Worker exited with code 1")

    // A replacement worker's requests are unaffected by the previous generation's failure.
    const id = registry.nextId("check")
    const resumed = registry.register<{ durationMs: number }>(id, { timeoutMs: 60_000 })
    expect(registry.resolve(id, { durationMs: 12 })).toBe(true)

    await expect(resumed).resolves.toEqual({ durationMs: 12 })
    expect(registry.pendingCount).toBe(0)
    expect(registry.getMetrics()).toEqual({ pending: 0, timeouts: 0, failures: 1 })
  })

  test("reports pending depth while requests are outstanding", () => {
    const registry = new PendingRequestRegistry()
    for (let i = 0; i < 4; i++) {
      void registry.register(registry.nextId("check"), { timeoutMs: 60_000 }).catch(() => {})
    }
    expect(registry.getMetrics().pending).toBe(4)
    registry.rejectAll("shutdown")
    expect(registry.getMetrics().pending).toBe(0)
  })
})
