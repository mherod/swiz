import { afterEach, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import type { Worker } from "node:worker_threads"
import type {
  FileWatcherParentMessage,
  FileWatcherStatus,
  FileWatcherWorkerMessage,
} from "../worker-messages.ts"
import { flushRpc, workerClock } from "./test-utils/rpc.ts"
import { FileWatcherRegistry } from "./worker-file-watcher-registry.ts"

class FakeWatcherWorker extends EventEmitter {
  sent: FileWatcherWorkerMessage[] = []
  failSend = false
  postMessage(message: FileWatcherWorkerMessage): void {
    if (this.failSend) throw new Error("transport closed")
    this.sent.push(message)
  }
  unref(): void {}
  terminate(): Promise<number> {
    return Promise.resolve(0)
  }
  reply(message: FileWatcherParentMessage): void {
    this.emit("message", message)
  }
  request(type: "status" | "start") {
    const message = this.sent.findLast((entry) => entry.type === type)
    if (!message || (message.type !== "status" && message.type !== "start")) {
      throw new Error(`Missing ${type} request`)
    }
    return message
  }
}

const registries: FileWatcherRegistry[] = []
afterEach(() => {
  for (const registry of registries.splice(0)) registry.close()
})

function harness() {
  const worker = new FakeWatcherWorker()
  const clock = workerClock()
  const registry = new FileWatcherRegistry({
    workerFactory: () => worker as unknown as Worker,
    schedule: clock.schedule,
  })
  registries.push(registry)
  return { registry, worker, clock }
}

function snapshot(invalidationCount: number): FileWatcherStatus[] {
  return [
    {
      path: "/repo/.git/",
      label: "git:repo",
      watching: true,
      watcherCount: 1,
      lastInvalidation: 1_000,
      invalidationCount,
    },
  ]
}

test("waits for the requested sample instead of returning the previous reading", async () => {
  const { registry, worker } = harness()
  let settled = false
  const pending = Promise.resolve(registry.status()).then((value) => {
    settled = true
    return value
  })
  await flushRpc()
  expect(settled).toBe(false)
  const first = worker.request("status")
  worker.reply({ type: "status", id: first.id, status: snapshot(1) })
  expect(await pending).toEqual(snapshot(1))

  settled = false
  const next = registry.status().then((value) => {
    settled = true
    return value
  })
  worker.reply({ type: "status", id: first.id, status: snapshot(1) })
  await flushRpc()
  expect(settled).toBe(false)
  worker.reply({ type: "status", id: worker.request("status").id, status: snapshot(2) })
  expect(await next).toEqual(snapshot(2))
})

test("correlates overlapping reads even when replies arrive out of order", async () => {
  const { registry, worker, clock } = harness()
  const first = registry.status()
  const firstId = worker.request("status").id
  const second = registry.status()
  worker.reply({ type: "status", id: worker.request("status").id, status: snapshot(2) })
  worker.reply({ type: "status", id: firstId, status: snapshot(1) })
  expect(await first).toEqual(snapshot(1))
  expect(await second).toEqual(snapshot(2))
  expect(clock.callbacks.size).toBe(0)
  expect(worker.listenerCount("message")).toBe(1)
})

test("a silent worker times out and a late reply cannot settle the next read", async () => {
  const { registry, worker, clock } = harness()
  const pending = registry.status().catch((error) => error)
  const expiredId = worker.request("status").id
  clock.advance(1_000)
  expect(await pending).toMatchObject({ code: "TIMEOUT" })
  expect(clock.callbacks.size).toBe(0)
  let settled = false
  const next = registry.status().then((value) => {
    settled = true
    return value
  })
  worker.reply({ type: "status", id: expiredId, status: snapshot(1) })
  await flushRpc()
  expect(settled).toBe(false)
  worker.reply({ type: "status", id: worker.request("status").id, status: snapshot(2) })
  expect(await next).toEqual(snapshot(2))
})

test("caps outstanding requests and releases every timer after a polling burst", async () => {
  const { registry, worker, clock } = harness()
  const requests = Array.from({ length: 100 }, () => registry.status().catch((error) => error))
  expect(worker.sent.filter((message) => message.type === "status")).toHaveLength(32)
  expect(clock.callbacks.size).toBe(32)
  expect(worker.listenerCount("message")).toBe(1)
  clock.advance(1_000)
  const results = await Promise.all(requests)
  expect(results.filter((result) => result.code === "TIMEOUT")).toHaveLength(32)
  expect(results.filter((result) => result.code === "CAPACITY")).toHaveLength(68)
  expect(clock.callbacks.size).toBe(0)
  expect(worker.listenerCount("message")).toBe(1)
})

for (const event of ["error", "exit"] as const) {
  test(`worker ${event} rejects pending and future reads immediately`, async () => {
    const { registry, worker, clock } = harness()
    const pending = registry.status().catch((error) => error)
    worker.emit(event, event === "error" ? new Error("crash") : 0)
    expect(await pending).toMatchObject({ code: "WORKER_EXIT" })
    const count = worker.sent.length
    await expect(registry.status()).rejects.toMatchObject({ code: "WORKER_EXIT" })
    expect(worker.sent).toHaveLength(count)
    expect(clock.callbacks.size).toBe(0)
  })
}

test("transport and worker errors release requests without retaining their payloads", async () => {
  const { registry, worker, clock } = harness()
  worker.failSend = true
  await expect(registry.status()).rejects.toMatchObject({ code: "REMOTE" })
  worker.failSend = false
  const pending = registry.status().catch((error) => error)
  worker.reply({ type: "error", id: worker.request("status").id, error: "worker failure" })
  expect(await pending).toMatchObject({ code: "REMOTE" })
  expect(clock.callbacks.size).toBe(0)
})

test("close settles pending startup and status without posting future reads", async () => {
  const { registry, worker, clock } = harness()
  const status = registry.status().catch((error) => error)
  const start = registry.start().catch((error) => error)
  registry.close()
  expect(await status).toMatchObject({ code: "CLOSED" })
  expect(await start).toMatchObject({ code: "CLOSED" })
  const count = worker.sent.length
  await expect(registry.status()).rejects.toMatchObject({ code: "CLOSED" })
  await expect(registry.start()).rejects.toMatchObject({ code: "CLOSED" })
  expect(worker.sent).toHaveLength(count)
  expect(clock.callbacks.size).toBe(0)
})

test("startup shares the bounded reply router and cannot leak message listeners", async () => {
  const { registry, worker, clock } = harness()
  const first = registry.start()
  const second = registry.start()
  expect(worker.sent.filter((message) => message.type === "start")).toHaveLength(1)
  worker.reply({ type: "started", id: worker.request("start").id })
  await Promise.all([first, second])
  const stalled = registry.start().catch((error) => error)
  clock.advance(15_000)
  expect(await stalled).toMatchObject({ code: "TIMEOUT" })
  expect(worker.listenerCount("message")).toBe(1)
  expect(clock.callbacks.size).toBe(0)
})
