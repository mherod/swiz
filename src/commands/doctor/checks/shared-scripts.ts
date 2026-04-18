import { chmod, mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { type AgentSettingsId, getAgentSettingsSearchPaths } from "../../../agent-paths.ts"
import { CONFIGURABLE_AGENTS } from "../../../agents.ts"
import { isInlineHookDef, manifest } from "../../../manifest.ts"
import { HOOKS_DIR } from "../../../swiz-hook-commands.ts"
import { collectHookCommands, extractScriptPaths } from "../../../utils/config-commands.ts"
import { messageFromUnknownError } from "../../../utils/hook-json-helpers.ts"

async function extractPathsFromSettingsFile(
  settingsPath: string,
  agent: (typeof CONFIGURABLE_AGENTS)[number]
): Promise<string[]> {
  const file = Bun.file(settingsPath)
  if (!(await file.exists())) return []
  let settings: Record<string, unknown>
  try {
    settings = (await file.json()) as Record<string, unknown>
  } catch {
    return []
  }
  const hooksRaw = agent.wrapsHooks
    ? ((settings.hooks as Record<string, unknown>) ?? {})
    : ((settings[agent.hooksKey] as Record<string, unknown>) ?? {})
  const hooks = typeof hooksRaw === "object" && !Array.isArray(hooksRaw) ? hooksRaw : {}
  return [...collectHookCommands(hooks)].flatMap((cmd) => extractScriptPaths(cmd))
}

/** Collect deduplicated script file paths referenced in installed agent hook configs. */
export async function collectInstalledConfigScriptPaths(): Promise<string[]> {
  const paths: string[] = []
  for (const agent of CONFIGURABLE_AGENTS) {
    const agentId = agent.id as AgentSettingsId
    for (const settingsPath of getAgentSettingsSearchPaths(agentId)) {
      paths.push(...(await extractPathsFromSettingsFile(settingsPath, agent)))
    }
  }
  return [...new Set(paths)]
}

/** Verify that all executable script paths (manifest + config) exist and are executable. */
export async function buildScriptPathSourceMap(): Promise<Map<string, "manifest" | "config">> {
  const pathSource = new Map<string, "manifest" | "config">()
  for (const group of manifest) {
    for (const hook of group.hooks) {
      if (isInlineHookDef(hook)) continue
      pathSource.set(join(HOOKS_DIR, hook.file), "manifest")
    }
  }
  for (const p of await collectInstalledConfigScriptPaths()) {
    if (!pathSource.has(p)) pathSource.set(p, "config")
  }
  return pathSource
}

/** Collect all script file paths that should have execute permission. */
export async function collectExecutableScriptPaths(): Promise<string[]> {
  const paths: string[] = []
  for (const group of manifest) {
    for (const hook of group.hooks) {
      if (isInlineHookDef(hook)) continue
      paths.push(join(HOOKS_DIR, hook.file))
    }
  }
  paths.push(...(await collectInstalledConfigScriptPaths()))
  return [...new Set(paths)]
}

/** Return config-referenced script paths that do not exist on disk. */
export async function findMissingConfigScriptPaths(): Promise<string[]> {
  const configPaths = await collectInstalledConfigScriptPaths()
  const missing: string[] = []
  for (const p of configPaths) {
    if (!(await Bun.file(p).exists())) missing.push(p)
  }
  return missing
}

export interface MissingScriptFixSuccess {
  path: string
}
export interface MissingScriptFixFailure {
  path: string
  error: string
}

/** Create minimal executable stub scripts for config-referenced paths that are missing. */
export async function fixMissingConfigScripts(paths: string[]): Promise<{
  registered: MissingScriptFixSuccess[]
  failed: MissingScriptFixFailure[]
}> {
  const registered: MissingScriptFixSuccess[] = []
  const failed: MissingScriptFixFailure[] = []
  const stub =
    "#!/usr/bin/env bun\n// Registered by swiz doctor --fix. Implement this hook script.\n"
  for (const p of paths) {
    try {
      await mkdir(dirname(p), { recursive: true })
      await Bun.write(p, stub)
      await chmod(p, 0o755)
      registered.push({ path: p })
    } catch (err: unknown) {
      failed.push({ path: p, error: messageFromUnknownError(err) })
    }
  }
  return { registered, failed }
}
