import { dirname, join } from "node:path"
import { getHomeDirOrNull } from "./home.ts"

const SWIZ_ROOT = dirname(Bun.main)
const HOOKS_DIR = join(SWIZ_ROOT, "hooks")
const LEGACY_HOME = getHomeDirOrNull()
const LEGACY_HOOK_DIRS = [
  "$HOME/.claude/hooks/",
  ...(LEGACY_HOME ? [`${LEGACY_HOME}/.claude/hooks/`] : []),
]

export { HOOKS_DIR, SWIZ_ROOT, LEGACY_HOOK_DIRS }

export function isSwizCommand(cmd: unknown): boolean {
  if (typeof cmd !== "string") return false
  return (
    cmd.includes(HOOKS_DIR) ||
    cmd.includes(join(SWIZ_ROOT, "index.ts")) ||
    cmd.includes("swiz dispatch")
  )
}

export function isLegacySwizCommand(cmd: unknown): boolean {
  if (typeof cmd !== "string") return false
  return LEGACY_HOOK_DIRS.some((dir) => cmd.includes(dir))
}

export function isManagedSwizCommand(cmd: unknown): boolean {
  return isSwizCommand(cmd) || isLegacySwizCommand(cmd)
}
