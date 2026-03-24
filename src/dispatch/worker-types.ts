/**
 * Shared message protocol types for Bun worker ↔ pool communication.
 * Imported by both hook-worker.ts (worker side) and worker-pool.ts (pool side).
 */

export interface RunHookMessage {
  id: string
  type: "run-hook"
  file: string
  payloadStr: string
  timeoutSec?: number
}

export interface ErrorResult {
  id: string
  type: "hook-error"
  error: string
}
