import { afterEach, describe, expect, it, spyOn } from "bun:test"
import { fetchJson, postJson } from "./http.ts"

let restoreFetch: (() => void) | undefined

function mockFetch(implementation: (...args: Parameters<typeof fetch>) => Promise<Response>) {
  const spy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(implementation, { preconnect: globalThis.fetch.preconnect })
  )
  restoreFetch = () => spy.mockRestore()
  return spy
}

afterEach(() => restoreFetch?.())

describe("HTTP request cancellation", () => {
  it("does not fetch when already aborted", async () => {
    const fetch = mockFetch(async () => Response.json({ ok: true }))
    const controller = new AbortController()
    controller.abort(new Error("cancelled"))
    await expect(fetchJson("/cancelled", controller.signal)).rejects.toThrow("cancelled")
    expect(fetch).not.toHaveBeenCalled()
  })

  it("aborts an active POST without retrying it", async () => {
    const fetch = mockFetch(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
        })
    )
    const controller = new AbortController()
    const request = postJson("/cancelled", { sessionId: "first" }, controller.signal)
    queueMicrotask(() => controller.abort(new Error("cancelled")))
    await expect(request).rejects.toThrow("cancelled")
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it("cancels retry backoff before another attempt", async () => {
    const fetch = mockFetch(async () => new Response("busy", { status: 503 }))
    const controller = new AbortController()
    const request = fetchJson("/retry", controller.signal)
    setTimeout(() => controller.abort(new Error("cancelled")), 0)
    await expect(request).rejects.toThrow("cancelled")
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it("still retries a transient response when the caller remains active", async () => {
    let attempts = 0
    mockFetch(async () =>
      ++attempts === 1 ? new Response("busy", { status: 503 }) : Response.json({ ok: true })
    )
    await expect(fetchJson("/retry", new AbortController().signal)).resolves.toEqual({ ok: true })
    expect(attempts).toBe(2)
  })
})
