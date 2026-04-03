import type { HookGroup } from "../../hook-types.ts"
import type { ProjectSwizSettings } from "../../settings/types.ts"

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
      options?: { recursive?: boolean; depth?: number }
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
  | { type: "checkProject"; cwd: string }
  | { type: "pruneOldSessions"; activeSessions: string[] }
  | { type: "manifestResponse"; id: string; manifest: HookGroup[] }
  | { type: "settingsResponse"; id: string; settings: ProjectSwizSettings | null }
  | { type: "cooldownCheckResponse"; requestId: string; withinCooldown: boolean }

export type TranscriptMonitorParentMessage =
  | { type: "initialized" }
  | { type: "getManifest"; id: string; cwd: string }
  | { type: "getSettings"; id: string; cwd: string }
  | {
      type: "checkAndMarkCooldown"
      requestId: string
      hookId: string
      cooldown: number
      cwd: string
    }
