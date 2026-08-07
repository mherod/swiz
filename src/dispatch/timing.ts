export const DISPATCH_STAGE_NAMES = [
  "cliBootstrap",
  "capture",
  "repository",
  "replay",
  "manifest",
  "enrichment",
  "syncHooks",
  "asyncHooks",
  "persistence",
] as const

export type DispatchStage = (typeof DISPATCH_STAGE_NAMES)[number]

export type DispatchStageDurations = Partial<Record<DispatchStage, number>>

export interface DispatchTimingSnapshot {
  route: string
  stages: DispatchStageDurations
  hookCount: number
}

/** Accumulate repeated work in a stage while rejecting invalid timing input. */
export function addDispatchStageDuration(
  stages: DispatchStageDurations,
  stage: DispatchStage,
  durationMs: number
): void {
  if (!Number.isFinite(durationMs) || durationMs < 0) return
  stages[stage] = (stages[stage] ?? 0) + durationMs
}
