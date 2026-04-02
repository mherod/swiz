import { backup as originalBackup } from "../../utils/file-utils.ts"

/** Helper for writing files with backup. Uses `Bun.write`. */
export async function writeWithBackup(path: string, content: string): Promise<void> {
  await originalBackup(path)
  await Bun.write(path, content)
}

/** Helper for checking if a file exists. Uses `Bun.file(path).exists()`. */
export async function exists(path: string): Promise<boolean> {
  return await Bun.file(path).exists()
}

/** Helper for removing a file via trash with rm -f fallback. */
export async function removeFile(path: string): Promise<void> {
  if (!(await exists(path))) return

  try {
    const rm = Bun.spawn(["trash", path], {
      stdout: "ignore",
      stderr: "pipe",
    })
    await rm.exited
    if (rm.exitCode !== 0) {
      const rmForce = Bun.spawn(["rm", "-f", path])
      await rmForce.exited
    }
  } catch (_e) {
    const rmForce = Bun.spawn(["rm", "-f", path])
    await rmForce.exited
  }
}
