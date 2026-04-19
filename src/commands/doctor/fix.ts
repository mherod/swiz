import { cp, readdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { AGENTS, getAgent } from "../../agents.ts"
import { getHomeDirWithFallback } from "../../home.ts"
import { listProviderAdapters } from "../../provider-adapters.ts"
import { defaultTrashPath } from "../../session-data-delete.ts"
import {
  findSkillConflicts,
  parseFrontmatterField,
  SKILL_PRECEDENCE,
  type SkillConflict,
  type SkillConflictEntry,
} from "../../skill-utils.ts"
import { messageFromUnknownError } from "../../utils/hook-json-helpers.ts"
import { stripQuotes } from "../../utils/quoted-string.ts"
import { convertSkillContent } from "../../utils/skill-conversion.ts"
import type { CheckResult } from "./types.ts"

/**
 * Doctor fix/check helpers for skill conflicts, invalid skill entries, and
 * plugin cache synchronization. Keeping this logic out of `doctor.ts` lets the
 * command entry stay focused on orchestration and cleanup flows.
 */
const HOME = getHomeDirWithFallback("")

/** Default description injected by swiz doctor --fix into generated SKILL.md stubs. */
const SKILL_PLACEHOLDER_DESCRIPTION = "Add a description for this skill."

export function displayPath(path: string): string {
  return HOME && path.startsWith(HOME) ? `~${path.slice(HOME.length)}` : path
}

function formatSkillPrecedence(): string {
  return SKILL_PRECEDENCE.map((dir) => displayPath(dir)).join(" > ")
}

export function buildSkillConflictResults(conflicts: SkillConflict[]): CheckResult[] {
  if (conflicts.length === 0) {
    return [
      {
        name: "Skill conflicts",
        status: "pass",
        detail: `no duplicate skill names across ${SKILL_PRECEDENCE.length} skill directories`,
      },
    ]
  }

  const precedence = formatSkillPrecedence()
  return conflicts.map((conflict) => ({
    name: `Skill conflict: ${conflict.name}`,
    status: "warn",
    detail:
      `active=${displayPath(conflict.active.path)}; overridden=` +
      `${conflict.overridden.map((entry) => displayPath(entry.path)).join(", ")}; ` +
      `precedence=${precedence} — run: swiz doctor --fix`,
  }))
}

type InvalidSkillKind =
  | "missing_skill_md"
  | "empty_skill_md"
  | "no_frontmatter"
  | "missing_frontmatter_fields"
  | "name_mismatch"
  | "placeholder_description"

export interface InvalidSkillEntry {
  name: string
  skillDir: string
  entryDir: string
  kind: InvalidSkillKind
  reason: string
  actualName?: string
}

/** Required frontmatter fields that every SKILL.md must declare. */
const REQUIRED_SKILL_FIELDS = ["name", "description"] as const

function validateSkillFrontmatter(
  content: string,
  dirName: string,
  base: { name: string; skillDir: string; entryDir: string }
): InvalidSkillEntry[] {
  const issues: InvalidSkillEntry[] = []
  const missing = REQUIRED_SKILL_FIELDS.filter((f) => !parseFrontmatterField(content, f))
  if (missing.length > 0) {
    issues.push({
      ...base,
      kind: "missing_frontmatter_fields",
      reason: `missing required frontmatter field(s): ${missing.join(", ")}`,
    })
  }
  const rawName = parseFrontmatterField(content, "name") ?? ""
  if (rawName) {
    const unquotedName = rawName.replace(/^["']|["']$/g, "")
    if (unquotedName !== dirName) {
      issues.push({
        ...base,
        kind: "name_mismatch",
        reason: `frontmatter name "${unquotedName}" does not match directory name "${dirName}"`,
        actualName: unquotedName,
      })
    }
  }
  const description = parseFrontmatterField(content, "description")
  if (description?.trim() === SKILL_PLACEHOLDER_DESCRIPTION) {
    issues.push({
      ...base,
      kind: "placeholder_description",
      reason: "description is the generated placeholder — update SKILL.md with a real description",
    })
  }
  return issues
}

function validateSkillContent(
  content: string,
  dirName: string,
  skillDir: string,
  entryDir: string
): InvalidSkillEntry[] {
  const base = { name: dirName, skillDir, entryDir }
  const frontmatterIssues = validateSkillFrontmatter(content, dirName, base)
  if (frontmatterIssues.length > 0) return frontmatterIssues
  return []
}

async function validateSkillEntry(
  entry: import("node:fs").Dirent,
  skillDir: string
): Promise<InvalidSkillEntry[]> {
  if (!entry.isDirectory() || entry.name.startsWith(".")) return []
  const entryDir = join(skillDir, entry.name)
  const skillPath = join(entryDir, "SKILL.md")
  const base = { name: entry.name, skillDir, entryDir }
  const file = Bun.file(skillPath)
  if (!(await file.exists())) {
    return [{ ...base, kind: "missing_skill_md", reason: "missing SKILL.md" }]
  }
  const content = await file.text()
  if (!content.trim()) return [{ ...base, kind: "empty_skill_md", reason: "empty SKILL.md" }]
  if (!/^---/m.test(content)) {
    return [
      {
        ...base,
        kind: "no_frontmatter",
        reason: "SKILL.md has no frontmatter block (expected --- delimiters)",
      },
    ]
  }
  return validateSkillContent(content, entry.name, skillDir, entryDir)
}

export async function findInvalidSkillEntries(): Promise<InvalidSkillEntry[]> {
  const invalid: InvalidSkillEntry[] = []
  for (const skillDir of SKILL_PRECEDENCE) {
    let entries: import("node:fs").Dirent[]
    try {
      entries = await readdir(skillDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      invalid.push(...(await validateSkillEntry(entry, skillDir)))
    }
  }
  invalid.sort((a, b) => a.name.localeCompare(b.name))
  return invalid
}

export function buildInvalidSkillResults(entries: InvalidSkillEntry[]): CheckResult[] {
  if (entries.length === 0) {
    return [
      {
        name: "Invalid skill entries",
        status: "pass",
        detail: `no invalid skill entries found across ${SKILL_PRECEDENCE.length} skill directories`,
      },
    ]
  }
  return entries.map((entry) => ({
    name: `Invalid skill: ${entry.name}`,
    status: "warn" as const,
    detail: `${displayPath(entry.entryDir)}: ${entry.reason} — run: swiz doctor --fix`,
  }))
}

interface InvalidSkillNameFixSuccess {
  name: string
  skillPath: string
  oldName: string
}
interface InvalidSkillGenerateSuccess {
  name: string
  skillPath: string
}
interface InvalidSkillFixFailure {
  name: string
  originalDir: string
  error: string
}

async function fixSkillNameMismatch(entry: InvalidSkillEntry): Promise<{ oldName: string } | null> {
  const skillPath = join(entry.entryDir, "SKILL.md")
  try {
    const content = await Bun.file(skillPath).text()
    const rawName = parseFrontmatterField(content, "name") ?? ""
    const oldName = stripQuotes(rawName)
    const updated = content.replace(/^(name:\s*)["']?[^"'\n]+["']?/m, `$1${entry.name}`)
    await Bun.write(skillPath, updated)
    return { oldName }
  } catch {
    return null
  }
}

async function generateSkillMd(entry: InvalidSkillEntry): Promise<boolean> {
  const skillPath = join(entry.entryDir, "SKILL.md")
  try {
    const stub = `---\nname: ${entry.name}\ndescription: ${SKILL_PLACEHOLDER_DESCRIPTION}\n---\n`
    await Bun.write(skillPath, stub)
    return true
  } catch {
    return false
  }
}

export async function fixInvalidSkillEntries(entries: InvalidSkillEntry[]): Promise<{
  nameFixed: InvalidSkillNameFixSuccess[]
  generated: InvalidSkillGenerateSuccess[]
  failed: InvalidSkillFixFailure[]
}> {
  const nameFixed: InvalidSkillNameFixSuccess[] = []
  const generated: InvalidSkillGenerateSuccess[] = []
  const failed: InvalidSkillFixFailure[] = []
  for (const entry of entries) {
    const skillPath = join(entry.entryDir, "SKILL.md")
    switch (entry.kind) {
      case "missing_skill_md":
        if (await generateSkillMd(entry)) generated.push({ name: entry.name, skillPath })
        else {
          failed.push({
            name: entry.name,
            originalDir: entry.entryDir,
            error: "could not create SKILL.md",
          })
        }
        break
      case "name_mismatch": {
        const result = await fixSkillNameMismatch(entry)
        if (result !== null)
          nameFixed.push({ name: entry.name, skillPath, oldName: result.oldName })
        else {
          failed.push({
            name: entry.name,
            originalDir: entry.entryDir,
            error: "could not update SKILL.md name field",
          })
        }
        break
      }
      default:
        failed.push({ name: entry.name, originalDir: entry.entryDir, error: entry.reason })
    }
  }
  return { nameFixed, generated, failed }
}

export interface PluginCacheInfo {
  pluginName: string
  sourcePath: string
  cachePath: string
  missingSkills: string[]
  extraSkills: string[]
  staleSkills: string[]
}

async function listSkillDirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
  } catch {
    return []
  }
}

async function findStaleSkills(
  sourceDir: string,
  cacheDir: string,
  shared: string[]
): Promise<string[]> {
  const stale: string[] = []
  for (const skill of shared) {
    const srcFile = Bun.file(join(sourceDir, skill, "SKILL.md"))
    const cacheFile = Bun.file(join(cacheDir, skill, "SKILL.md"))
    try {
      const [srcText, cacheText] = await Promise.all([srcFile.text(), cacheFile.text()])
      if (srcText !== cacheText) stale.push(skill)
    } catch {}
  }
  return stale
}

async function comparePluginSkills(
  pluginName: string,
  cachePath: string,
  sourcePath: string
): Promise<PluginCacheInfo | null> {
  const sourceSkillsDir = join(sourcePath, "skills")
  const cacheSkillsDir = join(cachePath, "skills")
  const sourceSkills = await listSkillDirs(sourceSkillsDir)
  if (sourceSkills.length === 0) return null
  const cacheSkills = await listSkillDirs(cacheSkillsDir)
  const cacheSet = new Set(cacheSkills)
  const sourceSet = new Set(sourceSkills)
  const missing = sourceSkills.filter((s) => !cacheSet.has(s))
  const extra = cacheSkills.filter((s) => !sourceSet.has(s))
  const shared = sourceSkills.filter((s) => cacheSet.has(s))
  const stale = await findStaleSkills(sourceSkillsDir, cacheSkillsDir, shared)
  if (missing.length === 0 && extra.length === 0 && stale.length === 0) return null
  return {
    pluginName,
    sourcePath: sourceSkillsDir,
    cachePath: cacheSkillsDir,
    missingSkills: missing,
    extraSkills: extra,
    staleSkills: stale,
  }
}

async function loadJsonFileSafe<T>(path: string): Promise<T | null> {
  const file = Bun.file(path)
  if (!(await file.exists())) return null
  try {
    return await file.json()
  } catch {
    return null
  }
}

export async function checkPluginCacheStaleness(): Promise<PluginCacheInfo[]> {
  const swizRoot = dirname(Bun.main)
  const installedPath = join(HOME, ".claude", "plugins", "installed_plugins.json")
  type InstalledPlugins = { version?: number; plugins?: Record<string, { installPath: string }[]> }
  const installed = await loadJsonFileSafe<InstalledPlugins>(installedPath)
  if (!installed?.plugins) return []

  const marketplacePath = join(swizRoot, ".claude-plugin", "marketplace.json")
  type Marketplace = { name?: string; plugins?: { name: string; source: string }[] }
  const marketplace = await loadJsonFileSafe<Marketplace>(marketplacePath)
  if (!marketplace?.plugins || !marketplace.name) return []

  const results: PluginCacheInfo[] = []
  for (const plugin of marketplace.plugins) {
    const key = `${plugin.name}@${marketplace.name}`
    const entries = installed.plugins[key]
    if (!entries?.length) continue
    const info = await comparePluginSkills(
      plugin.name,
      entries[0]!.installPath,
      join(swizRoot, plugin.source)
    )
    if (info) results.push(info)
  }
  return results
}

export function buildPluginCacheResults(infos: PluginCacheInfo[]): CheckResult[] {
  if (infos.length === 0) {
    return [
      { name: "Plugin cache sync", status: "pass", detail: "installed plugin skills match source" },
    ]
  }
  return infos.map((info) => {
    const parts: string[] = []
    if (info.missingSkills.length > 0)
      parts.push(`missing from cache: ${info.missingSkills.join(", ")}`)
    if (info.staleSkills.length > 0) parts.push(`outdated in cache: ${info.staleSkills.join(", ")}`)
    if (info.extraSkills.length > 0) parts.push(`extra in cache: ${info.extraSkills.join(", ")}`)
    return {
      name: `Plugin cache: ${info.pluginName}`,
      status: "warn" as const,
      detail: `${parts.join("; ")} — run: swiz doctor --fix`,
    }
  })
}

async function fixPluginCache(
  infos: PluginCacheInfo[]
): Promise<{ synced: string[]; updated: string[]; failed: { skill: string; error: string }[] }> {
  const synced: string[] = []
  const updated: string[] = []
  const failed: { skill: string; error: string }[] = []

  for (const info of infos) {
    for (const skill of info.missingSkills) {
      try {
        await cp(join(info.sourcePath, skill), join(info.cachePath, skill), { recursive: true })
        synced.push(skill)
      } catch (err: unknown) {
        failed.push({ skill, error: messageFromUnknownError(err) })
      }
    }
    for (const skill of info.staleSkills) {
      try {
        await cp(join(info.sourcePath, skill), join(info.cachePath, skill), {
          recursive: true,
          force: true,
        })
        updated.push(skill)
      } catch (err: unknown) {
        failed.push({ skill, error: messageFromUnknownError(err) })
      }
    }
  }

  return { synced, updated, failed }
}

export async function removeInvalidCategoryFields(): Promise<{
  cleaned: string[]
  failed: { skill: string; error: string }[]
}> {
  const cleaned: string[] = []
  const failed: { skill: string; error: string }[] = []

  for (const skillDir of SKILL_PRECEDENCE) {
    let entries: import("node:fs").Dirent[]
    try {
      entries = await readdir(skillDir, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue
      const skillPath = join(skillDir, entry.name, "SKILL.md")
      try {
        const file = Bun.file(skillPath)
        if (!(await file.exists())) continue

        const content = await file.text()
        // Remove category field from frontmatter
        const updated = content.replace(/^category:\s*[^\n]*\n/m, "")

        if (updated !== content) {
          await Bun.write(skillPath, updated)
          cleaned.push(entry.name)
        }
      } catch (err: unknown) {
        failed.push({ skill: entry.name, error: messageFromUnknownError(err) })
      }
    }
  }

  return { cleaned, failed }
}

function getAgentIdForDir(dir: string): string | null {
  const home = getHomeDirWithFallback("")
  const expandedDir = dir.startsWith("~/") ? join(home, dir.slice(2)) : dir

  for (const adapter of listProviderAdapters()) {
    const expandedSkillDirs = adapter
      .getSkillDirs()
      .map((d) => (d.startsWith("~/") ? join(home, d.slice(2)) : d))
    if (expandedSkillDirs.includes(expandedDir)) return adapter.id
  }
  return null
}

function normalizeSkillContent(content: string): string {
  const withoutFrontmatter = content.replace(/^---[\s\S]*?^---[ \t]*\n?/m, "")
  return withoutFrontmatter
    .replace(/\r\n/g, "\n")
    .replace(/\n## Related Skills[\s\S]*?(?=\n#|\n##|$)/, "")
    .replace(/\n## Task Completion Evidence Fields[\s\S]*$/, "")
    .trim()
}

async function areSkillsSame(
  active: SkillConflictEntry,
  overridden: SkillConflictEntry
): Promise<boolean> {
  const activeRaw = await Bun.file(active.path).text()
  const overriddenRaw = await Bun.file(overridden.path).text()

  const activeNormalized = normalizeSkillContent(activeRaw)
  const overriddenNormalized = normalizeSkillContent(overriddenRaw)
  if (activeNormalized === overriddenNormalized) return true

  const activeAgentId = getAgentIdForDir(active.dir) ?? "claude"
  const overriddenAgentId = getAgentIdForDir(overridden.dir) ?? "claude"
  const { content: converted } = convertSkillContent(
    overriddenRaw,
    getAgent(overriddenAgentId)!,
    getAgent(activeAgentId)!,
    AGENTS
  )
  return activeNormalized === normalizeSkillContent(converted)
}

function splitFrontmatter(content: string): { frontmatter: string[]; body: string[] } {
  const lines = content.split("\n")
  if (lines[0] !== "---") return { frontmatter: [], body: lines }
  const closeIdx = lines.indexOf("---", 1)
  if (closeIdx === -1) return { frontmatter: [], body: lines }
  return { frontmatter: lines.slice(1, closeIdx), body: lines.slice(closeIdx + 1) }
}

function lineDiff(aLines: string[], bLines: string[]): { added: string[]; removed: string[] } {
  const aSet = new Set(aLines)
  const bSet = new Set(bLines)
  return {
    added: aLines.filter((l) => !bSet.has(l)),
    removed: bLines.filter((l) => !aSet.has(l)),
  }
}

function formatDiffResult(
  countStr: string,
  section: string,
  totalChanged: number,
  allAdded: string[],
  allRemoved: string[]
): string {
  if (totalChanged <= 4) {
    const parts: string[] = []
    for (const l of allRemoved) parts.push(`-${l.trim().slice(0, 60)}`)
    for (const l of allAdded) parts.push(`+${l.trim().slice(0, 60)}`)
    return `${countStr} ${section}: ${parts.join(", ")}`
  }
  return `${countStr} in ${section}`
}

async function skillDiffSummary(activePath: string, overriddenPath: string): Promise<string> {
  try {
    const [activeText, overriddenText] = await Promise.all([
      Bun.file(activePath).text(),
      Bun.file(overriddenPath).text(),
    ])
    const active = splitFrontmatter(activeText)
    const overridden = splitFrontmatter(overriddenText)
    const fmDiff = lineDiff(active.frontmatter, overridden.frontmatter)
    const bodyDiff = lineDiff(active.body, overridden.body)
    const fmChanged = fmDiff.added.length > 0 || fmDiff.removed.length > 0
    const bodyChanged = bodyDiff.added.length > 0 || bodyDiff.removed.length > 0
    const totalAdded = fmDiff.added.length + bodyDiff.added.length
    const totalRemoved = fmDiff.removed.length + bodyDiff.removed.length
    const countStr = `+${totalAdded}/-${totalRemoved}`
    const section =
      fmChanged && !bodyChanged
        ? "frontmatter"
        : !fmChanged && bodyChanged
          ? "body"
          : "frontmatter+body"
    return formatDiffResult(
      countStr,
      section,
      totalAdded + totalRemoved,
      [...fmDiff.added, ...bodyDiff.added],
      [...fmDiff.removed, ...bodyDiff.removed]
    )
  } catch {
    return ""
  }
}

export async function fixSkillConflicts(
  conflicts: SkillConflict[],
  fix: boolean
): Promise<string[]> {
  const messages: string[] = []
  if (conflicts.length === 0) return messages

  if (!fix) {
    for (const conflict of conflicts) {
      for (const overridden of conflict.overridden) {
        if (await areSkillsSame(conflict.active, overridden)) {
          messages.push(
            `${conflict.name}: redundant version at ${displayPath(dirname(overridden.path))} — remove manually`
          )
        } else {
          const diffStats = await skillDiffSummary(conflict.active.path, overridden.path)
          const diffSuffix = diffStats ? ` (${diffStats})` : ""
          messages.push(
            `${conflict.name}: version at ${displayPath(dirname(overridden.path))} differs from active version${diffSuffix} — resolve manually`
          )
        }
      }
    }
    return messages
  }

  for (const conflict of conflicts) {
    for (const overridden of conflict.overridden) {
      const skillDir = dirname(overridden.path)
      messages.push(
        `Removed ${displayPath(skillDir)} (shadowed by ${displayPath(dirname(conflict.active.path))})`
      )
      await defaultTrashPath(skillDir)
    }
  }
  messages.push("Skill conflicts resolved")
  return messages
}

export async function fixStalePluginCache(infos: PluginCacheInfo[]): Promise<string[]> {
  const messages: string[] = []
  if (infos.length === 0) return messages
  const r = await fixPluginCache(infos)
  for (const skill of r.synced) messages.push(`${skill}: copied to plugin cache`)
  for (const skill of r.updated) messages.push(`${skill}: updated in plugin cache`)
  for (const item of r.failed) messages.push(`${item.skill}: ${item.error}`)
  if (r.synced.length > 0 || r.updated.length > 0) {
    messages.push("Restart Claude Code to pick up the changes.")
  }
  return messages
}

export { findSkillConflicts, type SkillConflict }
