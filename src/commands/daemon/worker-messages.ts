import type { HookGroup } from "../../hook-types.ts"
import type { ProjectSwizSettings } from "../../settings/types.ts"
import type { WatchRegistrationOptions } from "./cache/file-watcher-registry.ts"
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
  | { type: "start" }
  | { type: "status" }
  | { type: "unregisterByLabelSuffix"; suffix: string }
  | { type: "close" }

export type FileWatcherParentMessage =
  | { type: "invalidation"; path: string; label: string }
  | { type: "status"; status: FileWatcherStatus[] }
  | { type: "error"; error: string }
  | { type: "started" }

export type TranscriptMonitorWorkerMessage =
  | { type: "init" }
  | { type: "memoryPressure"; degraded: boolean }
  | { type: "checkProject"; id: string; cwd: string }
  | { type: "pruneOldSessions"; activeSessions: string[] }
  | { type: "getDispatchConcurrencyMetrics"; requestId: string }
  | { type: "manifestResponse"; id: string; manifest: HookGroup[]; error?: string }
  | {
      type: "settingsResponse"
      id: string
      settings: ProjectSwizSettings | null
      error?: string
    }
  | { type: "cooldownCheckResponse"; requestId: string; withinCooldown: boolean; error?: string }

export type TranscriptMonitorParentMessage =
  /** `error` set means the worker could not construct its monitor and will serve nothing. */
  | { type: "initialized"; error?: string }
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
      /** Set when the worker had no monitor to read; metrics carry zeros. */
      error?: string
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
