import { mkdir, rename } from "node:fs/promises"
import { dirname, join } from "node:path"
import { getHomeDir } from "../home.ts"

// ─── Two-way skill sync memory ───────────────────────────────────────────────
//
// What each root held after the last two-way pass, so a skill that disappears
// from one root can be told apart from one that was never there: the first is a
// deletion to carry to the other roots, the second a new skill to copy in. Kept
// on disk so deletions made while no watch was running are still recognised.
// Runtime state, deliberately separate from settings.

export interface SkillSyncState {
  /** Root directory → skill name → tree stamp of that root's copy after the last pass. */
  roots: Record<string, Record<string, string>>
}

export function skillSyncStatePath(homeDir = getHomeDir()): string {
  return join(homeDir, ".swiz", "skill-sync-state.json")
}

/** Missing or unreadable state starts empty: nothing is treated as deleted until seen once. */
export async function loadSkillSyncState(path: string): Promise<SkillSyncState> {
  try {
    const parsed = (await Bun.file(path).json()) as Partial<SkillSyncState>
    return parsed && typeof parsed.roots === "object" && parsed.roots !== null
      ? { roots: parsed.roots }
      : { roots: {} }
  } catch {
    return { roots: {} }
  }
}

/** Atomic replace, so a watch stopped mid-write never leaves truncated state. */
export async function saveSkillSyncState(path: string, state: SkillSyncState): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  await Bun.write(temporary, `${JSON.stringify(state, null, 2)}\n`)
  await rename(temporary, path)
}
