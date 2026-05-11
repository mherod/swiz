import { realpath } from "node:fs/promises"
import { basename, dirname, join as joinPath, resolve } from "node:path"

export async function resolveCanonical(p: string): Promise<string> {
  const absolute = resolve(p)
  try {
    return await realpath(absolute)
  } catch {
    let dir = dirname(absolute)
    let rest = basename(absolute)
    while (dir !== dirname(dir)) {
      try {
        const realDir = await realpath(dir)
        return joinPath(realDir, rest)
      } catch {
        rest = `${basename(dir)}/${rest}`
        dir = dirname(dir)
      }
    }
    return absolute
  }
}

export function isHiddenTopLevelHomePath(target: string, homeDir: string): boolean {
  const normalizedTarget = target.replace(/\\/g, "/")
  const normalizedHome = homeDir.replace(/\\/g, "/").replace(/\/$/, "")
  if (normalizedTarget === normalizedHome) return false
  if (!normalizedTarget.startsWith(`${normalizedHome}/`)) return false

  const relative = normalizedTarget.slice(normalizedHome.length + 1)
  const firstSegment = relative.split("/")[0] ?? ""
  return firstSegment.startsWith(".")
}
