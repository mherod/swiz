import { dirname } from "node:path"
import { countContentStats } from "./file-metrics.ts"
import { USE_COMPACT_MEMORY_SKILL } from "./memory-compaction-guidance.ts"
import { getMemoryThresholdViolations, type MemoryThresholds } from "./memory-thresholds.ts"
import { resolveProjectMemory } from "./project-memory.ts"
import {
  DEFAULT_MEMORY_LINE_THRESHOLD,
  DEFAULT_MEMORY_WORD_THRESHOLD,
  readProjectSettings,
  readSwizSettings,
  resolveMemoryThresholds,
} from "./settings.ts"

async function readThresholds(path: string): Promise<MemoryThresholds> {
  const location = await resolveProjectMemory(dirname(path))
  if (!location) throw new Error("Memory destination must belong to a repository")
  const project = await readProjectSettings(location.root)
  const user = await readSwizSettings({ strict: false })
  const limits = resolveMemoryThresholds(project, user, {
    memoryLineThreshold: DEFAULT_MEMORY_LINE_THRESHOLD,
    memoryWordThreshold: DEFAULT_MEMORY_WORD_THRESHOLD,
  })
  return { lineThreshold: limits.memoryLineThreshold, wordThreshold: limits.memoryWordThreshold }
}

export type ValidateMemoryWrite = (path: string, content: string) => Promise<void>

export async function validateMigrationWrite(
  path: string,
  content: string,
  thresholds: (path: string) => Promise<MemoryThresholds> = readThresholds
): Promise<void> {
  const violations = getMemoryThresholdViolations(
    countContentStats(content),
    await thresholds(path)
  )
  if (violations.length) {
    throw new Error(
      `Memory thresholds exceeded: ${violations.join(", ")}. ${USE_COMPACT_MEMORY_SKILL} before retrying migration.`
    )
  }
}
