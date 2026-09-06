import { EventEmitter } from "node:events"
import type {
  TranscriptMonitorParentMessage,
  TranscriptMonitorWorkerMessage,
} from "../../worker-messages.ts"
import type { RpcScheduler } from "../worker-rpc.ts"

export function workerClock(): {
  schedule: RpcScheduler
  callbacks: Map<() => void, number>
  advance(ms: number): void
} {
  let now = 0
  const callbacks = new Map<() => void, number>()
  const schedule: RpcScheduler = (callback, delay) => {
    callbacks.set(callback, now + delay)
    return () => callbacks.delete(callback)
  }
  return {
    schedule,
    callbacks,
    advance: (ms: number) => {
      now += ms
      for (const [callback, due] of [...callbacks]) {
        if (due <= now && callbacks.delete(callback)) callback()
      }
    },
  }
}

export class FakeTranscriptWorker extends EventEmitter {
  sent: TranscriptMonitorWorkerMessage[] = []
  terminated = false
  postMessage(message: TranscriptMonitorWorkerMessage): void {
    this.sent.push(message)
  }
  unref(): void {}
  terminate(): Promise<number> {
    this.terminated = true
    return Promise.resolve(0)
  }
  reply(message: TranscriptMonitorParentMessage): void {
    this.emit("message", message)
  }
  initialize(): void {
    const init = this.sent.find((msg) => msg.type === "init")
    if (!init || init.type !== "init") throw new Error("Missing init request")
    this.reply({ type: "initialized", id: init.id })
  }
}

export const flushRpc = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve))
