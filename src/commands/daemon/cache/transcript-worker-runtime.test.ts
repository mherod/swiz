import { expect, test } from "bun:test"
import type { TranscriptMonitorParentMessage } from "../worker-messages.ts"
import { flushRpc, workerClock } from "./test-utils/rpc.ts"
import type { TranscriptMonitor } from "./transcript-monitor.ts"
import { TranscriptWorkerRuntime } from "./transcript-worker-runtime.ts"

test("worker services resolve, reject, expire and close through one dispatcher", async () => {
  const clock = workerClock()
  const sent: TranscriptMonitorParentMessage[] = []
  let caches!: ConstructorParameters<typeof TranscriptMonitor>[0]
  const runtime = new TranscriptWorkerRuntime(
    (msg) => sent.push(msg),
    (value) => {
      caches = value
      return {
        checkProject: async () => {},
        pruneOldSessions: () => {},
        terminate: () => {},
        getDispatchConcurrencyMetrics: () => ({ active: 0, queued: 0, maxConcurrent: 4 }),
      }
    },
    clock.schedule
  )
  runtime.handle({ type: "init", id: "init", rpcTimeoutMs: 100, maxPending: 3 })
  const manifest = caches.manifestCache.get("/project")
  const settings = caches.projectSettingsCache.get("/project").catch((error) => error)
  const cooldown = Promise.resolve(
    caches.cooldownRegistry.checkAndMark("hook", 1, "/project")
  ).catch((error) => error)
  const manifestRequest = sent.find((msg) => msg.type === "getManifest")!
  const settingsRequest = sent.find((msg) => msg.type === "getSettings")!
  if (manifestRequest.type !== "getManifest" || settingsRequest.type !== "getSettings")
    throw new Error("Missing RPC")
  runtime.handle({ type: "manifestResponse", id: manifestRequest.id, manifest: [] })
  runtime.handle({ type: "rpcError", id: settingsRequest.id, code: "REMOTE" })
  clock.advance(100)
  expect(await manifest).toEqual([])
  expect(await settings).toMatchObject({ code: "REMOTE" })
  expect(await cooldown).toMatchObject({ code: "TIMEOUT" })
  expect(runtime.snapshot()).toMatchObject({ pendingRequests: 0, rpcTimeouts: 1, rpcFailures: 2 })
  const pending = caches.manifestCache.get("/project").catch((error) => error)
  runtime.close()
  expect(await pending).toMatchObject({ code: "CLOSED" })
  expect(clock.callbacks.size).toBe(0)
})

test("worker check completion reports errors and later triggers still run", async () => {
  const clock = workerClock()
  const sent: TranscriptMonitorParentMessage[] = []
  const runtime = new TranscriptWorkerRuntime(
    (msg) => sent.push(msg),
    (caches) => ({
      checkProject: async () => {
        await caches.projectSettingsCache.get("/project")
      },
      pruneOldSessions: () => {},
      terminate: () => {},
      getDispatchConcurrencyMetrics: () => ({ active: 0, queued: 0, maxConcurrent: 4 }),
    }),
    clock.schedule
  )
  runtime.handle({ type: "init", id: "init", rpcTimeoutMs: 100, maxPending: 3 })
  runtime.handle({ type: "checkProject", id: "first", cwd: "/project" })
  clock.advance(100)
  await flushRpc()
  expect(sent.find((msg) => msg.type === "checkProjectResponse")).toMatchObject({
    id: "first",
    error: "Transcript monitor check failed",
  })
  runtime.handle({ type: "checkProject", id: "second", cwd: "/project" })
  const request = sent.findLast((msg) => msg.type === "getSettings")!
  if (request.type !== "getSettings") throw new Error("Missing RPC")
  runtime.handle({ type: "settingsResponse", id: request.id, settings: null })
  await flushRpc()
  const result = sent.findLast((msg) => msg.type === "checkProjectResponse")!
  expect(result).toMatchObject({ id: "second" })
  expect(result).not.toHaveProperty("error")
  expect(runtime.snapshot()).toMatchObject({ activeChecks: 0, pendingRequests: 0 })
  runtime.close()
})

test("worker startup and metrics failures return explicit errors", () => {
  const sent: TranscriptMonitorParentMessage[] = []
  const runtime = new TranscriptWorkerRuntime(
    (msg) => sent.push(msg),
    () => {
      throw new Error("private")
    }
  )
  runtime.handle({ type: "init", id: "startup", rpcTimeoutMs: 100, maxPending: 3 })
  runtime.handle({ type: "getDispatchConcurrencyMetrics", requestId: "metrics" })
  expect(sent).toEqual([
    { type: "rpcError", id: "startup", code: "REMOTE" },
    { type: "rpcError", id: "metrics", code: "REMOTE" },
  ])
  runtime.close()
})
