import { existsSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { SkillSyncFileSystem } from "../commands/skill.ts"
import { stampSkillDir } from "./skill-sync-watch.ts"

/** Stage a replacement chain together, then publish it with a recoverable root swap. */
export async function withProjectSkillTransaction<T>(
  targetRoot: string,
  fs: SkillSyncFileSystem,
  run: (stagedRoot: string) => Promise<T>
): Promise<T> {
  await mkdir(dirname(targetRoot), { recursive: true })
  const existed = existsSync(targetRoot)
  const before = await stampSkillDir(targetRoot)
  const temporary = await fs.createTemporaryDirectory(join(dirname(targetRoot), ".skills-group-"))
  const staged = join(temporary, "skills")
  const backup = join(temporary, "previous")
  let preserveBackup = false
  try {
    if (existed) await fs.copyDirectory(targetRoot, staged)
    else await mkdir(staged)
    const result = await run(staged)
    if (existsSync(targetRoot) !== existed || (await stampSkillDir(targetRoot)) !== before) {
      throw new Error("Project skills changed while staging the replacement group; rerun sync.")
    }
    if (existed) await fs.moveDirectory(targetRoot, backup)
    try {
      await fs.moveDirectory(staged, targetRoot)
    } catch (error) {
      if (existed) {
        try {
          await fs.moveDirectory(backup, targetRoot)
        } catch {
          preserveBackup = true
          throw new Error(
            `Replacement group failed; previous skills remain recoverable at ${backup}`,
            { cause: error }
          )
        }
      }
      throw error
    }
    return result
  } finally {
    if (!preserveBackup) await fs.removeDirectory(temporary)
  }
}
