import { existsSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { getHomeDirOrNull } from "./home.ts"

/** Model alias applied when entering `planning` or `reviewing` project states. */
export const CLAUDE_MODEL_FOR_PLANNING_AND_REVIEW = "opus" as const

export type ClaudeModelSettingsScope = "global" | "project" | "local"

export function resolveClaudeSettingsPath(
  scope: ClaudeModelSettingsScope,
  targetDir: string,
  home: string
): string {
  if (scope === "global") return join(home, ".claude", "settings.json")
  if (scope === "project") return join(targetDir, ".claude", "settings.json")
  return join(targetDir, ".claude", "settings.local.json")
}

export async function readClaudeSettingsObject(path: string): Promise<Record<string, unknown>> {
  try {
    const raw = await Bun.file(path).text()
    if (!raw.trim()) return {}
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

export function readModelFromClaudeSettings(obj: Record<string, unknown>): string | undefined {
  const m = obj.model
  return typeof m === "string" && m.trim() !== "" ? m : undefined
}

export async function writeClaudeSettingsWithMutation(
  path: string,
  mutator: (obj: Record<string, unknown>) => void
): Promise<void> {
  const prev = existsSync(path) ? await Bun.file(path).text() : ""
  let obj: Record<string, unknown>
  if (prev.trim()) {
    try {
      const parsed: unknown = JSON.parse(prev)
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error(`Invalid JSON at ${path}: top level must be an object.`)
      }
      obj = parsed as Record<string, unknown>
    } catch (e) {
      const msg = e instanceof SyntaxError ? e.message : e instanceof Error ? e.message : String(e)
      throw new Error(`Invalid JSON at ${path}: ${msg}`)
    }
  } else {
    obj = {}
  }
  mutator(obj)
  const dir = dirname(path)
  await mkdir(dir, { recursive: true })
  if (prev.length > 0) {
    await Bun.write(`${path}.bak`, prev)
  }
  await Bun.write(path, `${JSON.stringify(obj, null, 2)}\n`)
}

export interface SetClaudeSettingsModelOptions {
  model: string
  scope: ClaudeModelSettingsScope
  /** Project root (used for project/local scopes). */
  cwd: string
}

/**
 * Sets the top-level `model` field in a Claude Code settings.json file.
 * Creates `.claude/` when needed. Backs up an existing file as `.bak`.
 */
export async function setClaudeSettingsModel(
  opts: SetClaudeSettingsModelOptions
): Promise<{ path: string }> {
  const home = getHomeDirOrNull()
  if (!home) throw new Error("HOME is not set; cannot resolve Claude settings paths.")
  const path = resolveClaudeSettingsPath(opts.scope, opts.cwd, home)
  await writeClaudeSettingsWithMutation(path, (obj) => {
    obj.model = opts.model
  })
  return { path }
}

export function effectiveClaudeModelFromLayers(
  globalObj: Record<string, unknown>,
  projectObj: Record<string, unknown>,
  localObj: Record<string, unknown>
): string | undefined {
  const l = readModelFromClaudeSettings(localObj)
  if (l !== undefined) return l
  const p = readModelFromClaudeSettings(projectObj)
  if (p !== undefined) return p
  return readModelFromClaudeSettings(globalObj)
}
