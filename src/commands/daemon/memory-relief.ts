import { clearFileCache } from "../../utils/file-cache.ts"
import { sessionDataCache } from "./session-data.ts"

/** Reconstructible history only: do not touch task stores, issue stores or pending writes. */
export function releaseTranscriptHistory(): void {
  clearFileCache()
  sessionDataCache.invalidateAll()
}

export function applyDaemonMemoryPressure(
  degraded: boolean,
  resources: {
    transcriptIndex: { invalidateAll(): void }
    snapshots: { clear(): void }
    transcriptMonitor: { setMemoryPressure(degraded: boolean): void }
  }
): void {
  if (degraded) {
    releaseTranscriptHistory()
    resources.transcriptIndex.invalidateAll()
    resources.snapshots.clear()
  }
  resources.transcriptMonitor.setMemoryPressure(degraded)
}
