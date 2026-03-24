import { mkdir, unlink } from "node:fs/promises"
import { dirname, join } from "node:path"
import { getHomeDir } from "./home.ts"

/** When present, `sessionstart-self-heal` skips running `swiz install` (after full uninstall). */
export function sessionstartSelfHealPausedPath(): string {
  return join(getHomeDir(), ".local", "share", "swiz", "sessionstart-self-heal-paused")
}

export async function isSessionstartSelfHealPaused(): Promise<boolean> {
  return Bun.file(sessionstartSelfHealPausedPath()).exists()
}

/** Call after a full swiz removal so manifest drift does not re-install hooks. */
export async function pauseSessionstartSelfHeal(): Promise<void> {
  const path = sessionstartSelfHealPausedPath()
  const dir = dirname(path)
  if (!(await Bun.file(dir).exists())) await mkdir(dir, { recursive: true })
  await Bun.write(path, "")
}

/** Call after `swiz install` writes agent hooks again. */
export async function resumeSessionstartSelfHeal(): Promise<void> {
  try {
    await unlink(sessionstartSelfHealPausedPath())
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e
  }
}
