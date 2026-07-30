import { mkdir, readdir } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { getAgentSettingsPath, getAgentSettingsSearchPaths } from "../../agent-paths.ts"
import { type AgentDef, CONFIGURABLE_AGENTS } from "../../agents.ts"
import { type DiscoveredCodexHook, discoverCodexHooks } from "../../codex-hooks.ts"
import { getHomeDir } from "../../home.ts"
import { canonicalizePath, isPathWithinRoot, resolveProjectRoot } from "../../project-identity.ts"
import { readJsonFile } from "../../utils/file-utils.ts"
import { collectCommands, mergeConfig } from "../install/config-helpers.ts"
import { writeWithBackup } from "../install/file-helpers.ts"
import { buildProposedAgentSettings, extractOldHooks } from "../install/settings-helpers.ts"

export interface AggressiveHookReplacement {
  agentName: string
  settingsPath: string
  removedHookCount: number
  installedHookCount: number
  cleanedSourceCount: number
  retainedHookCount: number
  retainedHookSources: string[]
  hookDiscoveryComplete: boolean
}

export interface AggressiveHookReplacementOptions {
  cwd?: string
  discoverCodexHooks?: typeof discoverCodexHooks
}

function countHookHandlers(value: unknown): number {
  if (Array.isArray(value)) {
    return value.reduce((count, entry) => count + countHookHandlers(entry), 0)
  }
  if (!value || typeof value !== "object") return 0

  const record = value as Record<string, unknown>
  if (
    typeof record.command === "string" ||
    typeof record.prompt === "string" ||
    typeof record.url === "string" ||
    (typeof record.type === "string" && !Array.isArray(record.hooks))
  ) {
    return 1
  }
  let count = 0
  for (const nested of Object.values(record)) count += countHookHandlers(nested)
  return count
}

function hasHookEntries(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0
  return !!value && typeof value === "object" && Object.keys(value).length > 0
}

function buildClearedAgentSettings(
  existing: Record<string, unknown>,
  agent: AgentDef
): Record<string, unknown> {
  if (agent.configStyle === "flat-lifecycle") return {}
  if (agent.wrapsHooks) return { ...existing, ...agent.wrapsHooks, hooks: {} }
  return { ...existing, [agent.hooksKey]: {} }
}

async function clearJsonHookSource(path: string, agent: AgentDef): Promise<number | null> {
  const file = Bun.file(path)
  if (!(await file.exists())) return null

  const existing = await readJsonFile(path)
  const oldHooks = extractOldHooks(existing, agent)
  const oldHookEntries = agent.configStyle === "flat-lifecycle" ? existing : oldHooks
  if (!hasHookEntries(oldHookEntries)) return null

  const cleared = buildClearedAgentSettings(existing, agent)
  await writeWithBackup(path, `${JSON.stringify(cleared, null, 2)}\n`)
  return countHookHandlers(oldHookEntries)
}

function tomlTablePath(line: string): string | null {
  const trimmed = line.trim()
  const arrayTable = trimmed.match(/^\[\[(.*?)\]\]\s*(?:#.*)?$/)
  if (arrayTable) return arrayTable[1]!.trim()
  const table = trimmed.match(/^\[(.*?)\]\s*(?:#.*)?$/)
  return table ? table[1]!.trim() : null
}

function isHooksTomlPath(path: string): boolean {
  return /^(?:hooks|"hooks"|'hooks')(?:\s*\.|\s*$)/.test(path.trim())
}

function isTopLevelHooksAssignment(line: string): boolean {
  return /^\s*(?:hooks|"hooks"|'hooks')(?:\s*\.\s*(?:[A-Za-z0-9_-]+|"[^"]*"|'[^']*'))*\s*=/.test(
    line
  )
}

function nextMultilineStringKind(
  line: string,
  current: '"""' | "'''" | null
): '"""' | "'''" | null {
  const doubleIndex = line.indexOf('"""')
  const literalIndex = line.indexOf("'''")
  let firstDelimiter: '"""' | "'''" | null = null
  if (doubleIndex >= 0 && (literalIndex < 0 || doubleIndex < literalIndex)) {
    firstDelimiter = '"""'
  } else if (literalIndex >= 0) {
    firstDelimiter = "'''"
  }
  const delimiter = current ?? firstDelimiter
  if (!delimiter) return null

  const openingIndex = current ? -delimiter.length : line.indexOf(delimiter)
  return line.indexOf(delimiter, openingIndex + delimiter.length) >= 0 ? null : delimiter
}

function assignmentEndLine(lines: string[], startLine: number): number {
  for (let lineIndex = startLine; lineIndex < lines.length; lineIndex++) {
    try {
      const parsed = Bun.TOML.parse(lines.slice(startLine, lineIndex + 1).join("\n"))
      if (Object.hasOwn(parsed, "hooks")) return lineIndex
    } catch {
      // Keep extending the candidate until the TOML value is complete.
    }
  }
  return lines.length - 1
}

export function stripCodexHooksFromToml(text: string): string {
  const lines = text.split("\n")
  const kept: string[] = []
  let skippingHooksTable = false
  let seenTable = false
  let multilineString: '"""' | "'''" | null = null

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    const startsInMultilineString = multilineString !== null
    multilineString = nextMultilineStringKind(line, multilineString)
    const tablePath = startsInMultilineString ? null : tomlTablePath(line)
    if (tablePath !== null) {
      seenTable = true
      skippingHooksTable = isHooksTomlPath(tablePath)
      if (!skippingHooksTable) kept.push(line)
      continue
    }
    if (skippingHooksTable) continue

    if (!seenTable && isTopLevelHooksAssignment(line)) {
      index = assignmentEndLine(lines, index)
      continue
    }
    kept.push(line)
  }

  return kept.join("\n")
}

async function clearTomlHookSource(path: string): Promise<number | null> {
  const file = Bun.file(path)
  if (!(await file.exists())) return null

  const existing = await file.text()
  const parsed = Bun.TOML.parse(existing) as Record<string, unknown>
  if (!Object.hasOwn(parsed, "hooks")) return null

  const cleaned = stripCodexHooksFromToml(existing)
  const cleanedParsed = Bun.TOML.parse(cleaned) as Record<string, unknown>
  const expected = { ...parsed }
  delete expected.hooks
  if (
    Object.hasOwn(cleanedParsed, "hooks") ||
    JSON.stringify(cleanedParsed) !== JSON.stringify(expected)
  ) {
    throw new Error(`Could not safely remove inline Codex hooks from ${path}`)
  }

  await writeWithBackup(path, cleaned)
  return countHookHandlers(parsed.hooks)
}

function projectLayerDirectories(projectRoot: string, cwd: string): string[] {
  const relativePath = relative(projectRoot, cwd)
  if (!relativePath || relativePath === ".") return [projectRoot]
  if (relativePath.startsWith(`..${sep}`) || relativePath === "..") return [projectRoot]

  const directories = [projectRoot]
  let current = projectRoot
  for (const segment of relativePath.split(sep).filter(Boolean)) {
    current = join(current, segment)
    directories.push(current)
  }
  return directories
}

async function codexUserTomlPaths(homeDir: string): Promise<string[]> {
  const codexHome = join(homeDir, ".codex")
  try {
    const entries = await readdir(codexHome, { withFileTypes: true })
    return entries
      .filter(
        (entry) =>
          entry.isFile() && (entry.name === "config.toml" || entry.name.endsWith(".config.toml"))
      )
      .map((entry) => join(codexHome, entry.name))
  } catch {
    return []
  }
}

function isEditableCodexSource(sourcePath: string, homeDir: string, projectRoot: string): boolean {
  if (!isAbsolute(sourcePath)) return false
  const path = canonicalizePath(resolve(sourcePath))
  const filename = basename(path)
  const supportedFile =
    filename === "hooks.json" || filename === "config.toml" || filename.endsWith(".config.toml")
  if (!supportedFile) return false

  const codexHome = canonicalizePath(resolve(homeDir, ".codex"))
  if (dirname(path) === codexHome) return true
  return dirname(path).endsWith(`${sep}.codex`) && isPathWithinRoot(path, projectRoot)
}

async function codexSupplementalSourcePaths(
  homeDir: string,
  cwd: string,
  discoveredHooks: DiscoveredCodexHook[] | null
): Promise<{ paths: string[]; projectRoot: string }> {
  const canonicalCwd = canonicalizePath(cwd)
  const projectRoot = await resolveProjectRoot(canonicalCwd)
  const paths = new Set<string>(await codexUserTomlPaths(homeDir))

  for (const directory of projectLayerDirectories(projectRoot, canonicalCwd)) {
    paths.add(join(directory, ".codex", "hooks.json"))
    paths.add(join(directory, ".codex", "config.toml"))
  }
  for (const hook of discoveredHooks ?? []) {
    if (isEditableCodexSource(hook.sourcePath, homeDir, projectRoot)) {
      paths.add(resolve(hook.sourcePath))
    }
  }

  paths.delete(getAgentSettingsPath("codex", homeDir))
  return { paths: [...paths], projectRoot }
}

function retainedCodexHooks(
  hooks: DiscoveredCodexHook[] | null,
  homeDir: string,
  projectRoot: string
): DiscoveredCodexHook[] {
  if (!hooks) return []
  return hooks.filter(
    (hook) =>
      hook.isManaged ||
      hook.pluginId !== null ||
      !isEditableCodexSource(hook.sourcePath, homeDir, projectRoot)
  )
}

function uniqueRetainedSources(hooks: DiscoveredCodexHook[]): string[] {
  return [
    ...new Set(
      hooks.map((hook) => {
        if (hook.isManaged) return `managed:${hook.source}`
        if (hook.pluginId) return `plugin:${hook.pluginId}`
        return `${hook.source}:${hook.sourcePath}`
      })
    ),
  ]
}

async function clearSupplementalJsonSources(
  agent: AgentDef,
  homeDir: string,
  cwd: string
): Promise<{ removedHookCount: number; cleanedSourceCount: number }> {
  let removedHookCount = 0
  let cleanedSourceCount = 0
  const primaryPath = getAgentSettingsPath(agent.id, homeDir)
  const canonicalCwd = canonicalizePath(cwd)
  const projectRoot = await resolveProjectRoot(canonicalCwd)
  const paths = new Set([
    ...getAgentSettingsSearchPaths(agent.id, { homeDir, cwd: canonicalCwd }),
    ...getAgentSettingsSearchPaths(agent.id, { homeDir, cwd: projectRoot }),
  ])

  for (const path of paths) {
    if (path === primaryPath) continue
    const removed = await clearJsonHookSource(path, agent)
    if (removed === null) continue
    removedHookCount += removed
    cleanedSourceCount++
  }
  return { removedHookCount, cleanedSourceCount }
}

async function clearCodexSupplementalSources(
  agent: AgentDef,
  homeDir: string,
  cwd: string,
  discoverHooks: typeof discoverCodexHooks
): Promise<{
  removedHookCount: number
  cleanedSourceCount: number
  retainedHookCount: number
  retainedHookSources: string[]
  hookDiscoveryComplete: boolean
}> {
  const discovered = await discoverHooks(cwd, homeDir)
  const supplemental = await codexSupplementalSourcePaths(homeDir, cwd, discovered)
  let removedHookCount = 0
  let cleanedSourceCount = 0

  for (const path of supplemental.paths) {
    const removed = path.endsWith(".json")
      ? await clearJsonHookSource(path, agent)
      : await clearTomlHookSource(path)
    if (removed === null) continue
    removedHookCount += removed
    cleanedSourceCount++
  }

  const retained = retainedCodexHooks(discovered, homeDir, supplemental.projectRoot)
  return {
    removedHookCount,
    cleanedSourceCount,
    retainedHookCount: retained.length,
    retainedHookSources: uniqueRetainedSources(retained),
    hookDiscoveryComplete: discovered !== null,
  }
}

/**
 * Replace every configurable agent's hook entries with a fresh swiz-only
 * global configuration. Supplemental user, profile, and project hook layers
 * are cleared so they cannot run alongside the global dispatcher. Managed,
 * plugin, and session Codex hooks are discovered and reported but never
 * modified.
 */
export async function replaceAgentHooksWithSwiz(
  agents: AgentDef[] = CONFIGURABLE_AGENTS,
  homeDir: string = getHomeDir(),
  options: AggressiveHookReplacementOptions = {}
): Promise<AggressiveHookReplacement[]> {
  const replacements: AggressiveHookReplacement[] = []
  const cwd = options.cwd ?? process.cwd()
  const discoverHooks = options.discoverCodexHooks ?? discoverCodexHooks

  for (const agent of agents) {
    const resolvedAgent = {
      ...agent,
      settingsPath: getAgentSettingsPath(agent.id, homeDir),
    }
    const existing = await readJsonFile(resolvedAgent.settingsPath)
    const oldHooks = extractOldHooks(existing, resolvedAgent)
    const oldHookEntries = resolvedAgent.configStyle === "flat-lifecycle" ? existing : oldHooks
    const swizHooks = mergeConfig(resolvedAgent, {})
    const newText = buildProposedAgentSettings(existing, resolvedAgent, swizHooks, {
      replaceAllHookEntries: true,
    })
    let removedHookCount = countHookHandlers(oldHookEntries)
    let cleanedSourceCount = 1
    let retainedHookCount = 0
    let retainedHookSources: string[] = []
    let hookDiscoveryComplete = true

    await mkdir(dirname(resolvedAgent.settingsPath), { recursive: true })
    await writeWithBackup(resolvedAgent.settingsPath, `${newText}\n`)

    if (agent.id === "codex") {
      const supplemental = await clearCodexSupplementalSources(
        resolvedAgent,
        homeDir,
        cwd,
        discoverHooks
      )
      removedHookCount += supplemental.removedHookCount
      cleanedSourceCount += supplemental.cleanedSourceCount
      retainedHookCount = supplemental.retainedHookCount
      retainedHookSources = supplemental.retainedHookSources
      hookDiscoveryComplete = supplemental.hookDiscoveryComplete
    } else {
      const supplemental = await clearSupplementalJsonSources(resolvedAgent, homeDir, cwd)
      removedHookCount += supplemental.removedHookCount
      cleanedSourceCount += supplemental.cleanedSourceCount
    }

    replacements.push({
      agentName: resolvedAgent.name,
      settingsPath: resolvedAgent.settingsPath,
      removedHookCount,
      installedHookCount: collectCommands(swizHooks).size,
      cleanedSourceCount,
      retainedHookCount,
      retainedHookSources,
      hookDiscoveryComplete,
    })
  }

  return replacements
}
