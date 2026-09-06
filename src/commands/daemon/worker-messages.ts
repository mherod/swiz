import type { HookGroup } from "../../hook-types.ts"
import type { ProjectSwizSettings } from "../../settings/types.ts"
import type { WatchRegistrationOptions } from "./cache/file-watcher-registry.ts"
import type { RpcFailureCode } from "./cache/worker-rpc.ts"
import type { WorkerMemorySnapshot } from "./memory-pressure.ts"

export interface FileWatcherStatus {
  path: string
  label: string
  watching: boolean
  watcherCount: number
  lastInvalidation: number | null
  invalidationCount: number
}

export type FileWatcherWorkerMessage =
  | { type: "init" }
  | {
      type: "register"
      path: string
      label: string
      options?: WatchRegistrationOptions
    }
  | { type: "start"; id: string }
  | { type: "status"; id: string }
  | { type: "unregisterByLabelSuffix"; suffix: string }
  | { type: "close" }

export type FileWatcherParentMessage =
  | { type: "invalidation"; path: string; label: string }
  | { type: "status"; id: string; status: FileWatcherStatus[] }
  | { type: "error"; id?: string; error: string }
  | { type: "started"; id: string }

export type TranscriptMonitorWorkerMessage =
  | { type: "init"; id: string; rpcTimeoutMs: number; maxPending: number }
  | { type: "memoryPressure"; degraded: boolean }
  | { type: "checkProject"; id: string; cwd: string }
  | { type: "pruneOldSessions"; activeSessions: string[] }
  | { type: "getDispatchConcurrencyMetrics"; requestId: string }
  | { type: "manifestResponse"; id: string; manifest: HookGroup[] }
  | { type: "settingsResponse"; id: string; settings: ProjectSwizSettings | null }
  | { type: "cooldownCheckResponse"; requestId: string; withinCooldown: boolean }
  | { type: "rpcError"; id: string; code: RpcFailureCode }

export type TranscriptMonitorParentMessage =
  | { type: "initialized"; id: string }
  | { type: "rpcError"; id: string; code: RpcFailureCode }
  | { type: "memorySnapshot"; snapshot: WorkerMemorySnapshot }
  | { type: "getManifest"; id: string; cwd: string }
  | { type: "getSettings"; id: string; cwd: string }
  | {
      type: "checkAndMarkCooldown"
      requestId: string
      hookId: string
      cooldown: number
      cwd: string
    }
  | {
      type: "dispatchConcurrencyMetricsResponse"
      requestId: string
      metrics: { active: number; queued: number; maxConcurrent: number }
    }
  | {
      type: "checkProjectResponse"
      id: string
      cwd: string
      durationMs: number
      error?: string
      /** True when the worker declined the check (degraded or uninitialized) and ran no work. */
      skipped?: boolean
    }
