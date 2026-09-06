import { parentPort } from "node:worker_threads"
import { getFileCacheMemoryStats } from "../../../utils/file-cache.ts"
import { releaseTranscriptHistory } from "../memory-relief.ts"
import type {
  TranscriptMonitorParentMessage,
  TranscriptMonitorWorkerMessage,
} from "../worker-messages.ts"
import { TranscriptWorkerRuntime } from "./transcript-worker-runtime.ts"

if (!parentPort) process.exit(1)
const port = parentPort!
const runtime = new TranscriptWorkerRuntime(
  (message) => port.postMessage(message),
  undefined,
  undefined,
  publishMemorySnapshot
)

function publishMemorySnapshot(): void {
  const state = runtime.snapshot()
  if (state.degraded) releaseTranscriptHistory()
  const memory = process.memoryUsage()
  const cache = getFileCacheMemoryStats()
  port.postMessage({
    type: "memorySnapshot",
    snapshot: {
      ...state,
      sampledAt: Date.now(),
      heapUsed: memory.heapUsed,
      external: memory.external,
      arrayBuffers: memory.arrayBuffers,
      fileCacheEntries: cache.entries,
      fileCacheEstimatedBytes: cache.estimatedBytes,
    },
  } satisfies TranscriptMonitorParentMessage)
}

const handle = (message: TranscriptMonitorWorkerMessage) => runtime.handle(message)
port.on("message", handle)
const timer = setInterval(publishMemorySnapshot, 30_000)
timer.unref()
port.on("close", () => {
  clearInterval(timer)
  port.off("message", handle)
  runtime.close()
})
