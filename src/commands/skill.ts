import { existsSync, realpathSync } from "node:fs"
import { cp, lstat, mkdir, mkdtemp, readdir, readlink, rename, rm, stat } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { orderBy } from "lodash-es"
import { AGENTS, type AgentDef, getAgent } from "../agents.ts"
import { detectCurrentAgent } from "../detect.ts"
import { findGitWorkTree } from "../git-helpers.ts"
import { getHomeDir } from "../home.ts"
import { SWIZ_SKILL_SYNC_LABEL } from "../launch-agents.ts"
import { getProviderAdapter } from "../provider-adapters.ts"
import { defaultTrashPath } from "../session-data-delete.ts"
import { claimShutdownSignals } from "../shutdown-claim.ts"
import {
  buildSkillAgentToolEnvironmentFooter,
  extractMandatedSkillTools,
  extractReferencedToolsFromSkillText,
  findSkills,
  getAgentsSkillDir,
  getAgentsSkillDirs,
  getLegacyAgentsSkillDir,
  getSkillToolAvailabilityWarning,
  parseFrontmatterField,
  stripFrontmatter,
} from "../skill-utils.ts"
import type { Command } from "../types.ts"
import { messageFromUnknownError } from "../utils/hook-json-helpers.ts"
import { parseQuotedString } from "../utils/quoted-string.ts"
import {
  eliminatePositionalArgs,
  expandInlineCommands,
  substituteArgs,
  unwrapInlineCommands,
} from "../utils/skill-content.ts"
import { convertSkillContent } from "../utils/skill-conversion.ts"
import { lazySkillHistory, type SkillHistory } from "../utils/skill-git-history.ts"
import {
  collectSkillTreeEntries,
  convertOverwriteMarkdown,
  convertSourceMarkdown,
  createSkillReferenceHistory,
  createSkillVocabulary,
  describeSkillResolution,
  planSkillResolution,
  type SkillFileResolution,
  type SkillFileResolutionKind,
  type SkillFileWrite,
  type SkillResolutionContext,
  type SkillTreeEntryKind,
  snapshotSkillBaseline,
} from "../utils/skill-sync-resolution.ts"
import {
  loadSkillSyncState,
  type SkillSyncState,
  saveSkillSyncState,
  skillSyncStatePath,
} from "../utils/skill-sync-state.ts"
import {
  DEFAULT_SKILL_SYNC_QUIET_MS,
  stampSkillDir,
  watchSkillSync,
} from "../utils/skill-sync-watch.ts"
import type { LaunchAgentFileAction } from "./install/launch-agent-config.ts"
import {
  installSkillSyncLaunchAgent,
  type SkillSyncAgentOptions,
  uninstallSkillSyncLaunchAgent,
} from "./install/skill-sync-agent.ts"

export { parseFrontmatterField, stripFrontmatter }

function primarySkillDir(agentId: string): string {
  if (agentId === "agents") return getAgentsSkillDir()
  const home = getHomeDir()
  const adapter = getProviderAdapter(agentId)
  const primary = adapter?.getSkillDirs()[0]
  if (primary) return primary

  return join(home, `.${agentId}`, "skills")
}

function sourceSkillDirs(agentId: string): string[] {
  if (agentId === "agents") return getAgentsSkillDirs()
  return [primarySkillDir(agentId)]
}

type AgentLike = { id: string; name: string }

const PSEUDO_AGENTS: Record<string, AgentLike> = {
  agents: { id: "agents", name: "Agents" },
}

function resolveForSync(id: string): AgentLike {
  const known = getAgent(id)
  if (known) return known
  const pseudo = PSEUDO_AGENTS[id]
  if (pseudo) return pseudo
  const validIds = [...AGENTS.map((a) => a.id), ...Object.keys(PSEUDO_AGENTS)]
  throw new Error(`Unknown agent: ${id}. Valid agent IDs: ${validIds.join(", ")}`)
}

async function listSkills() {
  const skills = await findSkills()
  if (skills.length === 0) {
    console.log("No skills found.")
    return
  }

  console.log(`\n  ${skills.length} skills available\n`)

  const maxName = Math.max(...skills.map((s) => s.name.length), 8)
  for (const skill of skills) {
    const tag = skill.source === "local" ? " (local)" : ""
    const desc = skill.description ? ` ${skill.description}` : ""
    console.log(`    ${skill.name.padEnd(maxName + 2)}${desc}${tag}`)
  }
  console.log()
}

async function readSkill(
  name: string,
  raw: boolean,
  noFrontMatter: boolean,
  positionalArgs: string[] = [],
  expandCommands: typeof expandInlineCommands = expandInlineCommands
) {
  const skills = await findSkills()
  const skill = skills.find((s) => s.name === name)

  if (!skill) {
    throw new Error(`Skill not found: ${name}\nRun "swiz skill" to list available skills.`)
  }

  const fileText = await Bun.file(skill.path).text()
  let content = fileText
  const availabilityWarning = getSkillToolAvailabilityWarning(name, content)
  if (availabilityWarning) {
    console.log(availabilityWarning.message)
  }
  content = substituteArgs(content, positionalArgs)
  if (!raw) {
    content = await expandCommands(content)
  }

  const scanBody = stripFrontmatter(content)
  const referencedFromBody = extractReferencedToolsFromSkillText(scanBody)
  const mandatedTools = extractMandatedSkillTools(fileText)
  const allReferencedTools = orderBy(
    [...new Set([...mandatedTools, ...referencedFromBody])],
    [(t) => t],
    ["asc"]
  )
  const agent = detectCurrentAgent()
  const agentToolFooter =
    agent !== null ? buildSkillAgentToolEnvironmentFooter(agent, allReferencedTools) : null

  if (noFrontMatter) {
    content = stripFrontmatter(content)
  }
  console.log(content)
  if (agentToolFooter) {
    console.log(agentToolFooter)
  }
}

function displayPath(path: string): string {
  const home = getHomeDir()
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path
}

/** Positional (non-flag) args, excluding values consumed by transfer options. */
function extractPositionals(args: string[]): string[] {
  const flagsWithValue = new Set(["--from", "--to", "--agents", "--project"])
  return args.filter((a, i) => !a.startsWith("--") && !flagsWithValue.has(args[i - 1] ?? ""))
}

/** Validate that a named skill exists in the source dir; returns the name. */
async function requireSkillName(fromSkillsDir: string, name: string): Promise<string> {
  if (await Bun.file(join(fromSkillsDir, name, "SKILL.md")).exists()) return name
  throw new Error(
    `Skill not found: ${name} (no SKILL.md at ${displayPath(join(fromSkillsDir, name))}).\nOmit the skill name to process all skills, or run "swiz skill" to list them.`
  )
}

/** Quote a frontmatter scalar when it would not survive a YAML round-trip unquoted. */
function yamlScalar(value: string): string {
  if (!value) return value
  const { quoteChar } = parseQuotedString(value)
  if (quoteChar) return value
  return /[:#"'\n]|^\s|\s$/.test(value) ? JSON.stringify(value) : value
}

// ─── Single-skill conversion (reads file, converts, writes) ──────────────────

async function convertSupplementaryEntry(
  entry: import("node:fs").Dirent,
  options: {
    srcDir: string
    destDir: string
    fromAgent: AgentDef
    toAgent: AgentDef
    dryRun: boolean
  }
): Promise<void> {
  const { srcDir, destDir, fromAgent, toAgent, dryRun } = options
  if (entry.name === "SKILL.md" || entry.name.startsWith(".")) return
  const srcPath = join(srcDir, entry.name)
  const destPath = join(destDir, entry.name)

  if (entry.isDirectory()) {
    if (entry.name === "node_modules") return
    if (!dryRun) {
      await mkdir(destPath, { recursive: true })
    }
    await convertSupplementaryFiles(srcPath, destPath, fromAgent, toAgent, dryRun)
  } else if (entry.isFile()) {
    if (entry.name.endsWith(".md")) {
      const original = await Bun.file(srcPath).text()
      const { content } = convertSkillContent(original, fromAgent, toAgent, AGENTS)
      if (!dryRun) {
        await Bun.write(destPath, content)
      }
    } else if (!dryRun) {
      await cp(srcPath, destPath, { recursive: true, force: true })
    }
  }
}

async function convertSupplementaryFiles(
  srcDir: string,
  destDir: string,
  fromAgent: AgentDef,
  toAgent: AgentDef,
  dryRun: boolean
): Promise<void> {
  let entries: import("node:fs").Dirent[]
  try {
    entries = await readdir(srcDir, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    await convertSupplementaryEntry(entry, { srcDir, destDir, fromAgent, toAgent, dryRun })
  }
}

async function convertSingleSkill(opts: {
  fromSkillsDir: string
  name: string
  targetDir: string
  from: string
  to: string
  dryRun: boolean
}): Promise<{ unmapped: string[]; warnSuffix: string }> {
  const original = await Bun.file(join(opts.fromSkillsDir, opts.name, "SKILL.md")).text()
  const fromAgent = getAgent(opts.from)!
  const toAgent = getAgent(opts.to)!
  const { content, unmapped } = convertSkillContent(original, fromAgent, toAgent, AGENTS)
  const warnSuffix = unmapped.length > 0 ? ` [⚠ unmapped: ${unmapped.join(", ")}]` : ""
  if (!opts.dryRun) {
    await mkdir(opts.targetDir, { recursive: true })
    await Bun.write(join(opts.targetDir, "SKILL.md"), content)
    await convertSupplementaryFiles(
      join(opts.fromSkillsDir, opts.name),
      opts.targetDir,
      fromAgent,
      toAgent,
      opts.dryRun
    )
  }
  return { unmapped, warnSuffix }
}

// ─── Bulk operations ────────────────────────────────────────────────────────

async function discoverSkillNames(skillsDir: string): Promise<string[]> {
  let entries: import("node:fs").Dirent[]
  try {
    entries = await readdir(skillsDir, { withFileTypes: true })
  } catch {
    return []
  }
  const names: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    // Package installs and hidden folders are never skills, even if they contain a SKILL.md.
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue
    if (await Bun.file(join(skillsDir, entry.name, "SKILL.md")).exists()) names.push(entry.name)
  }
  return orderBy(names, [(n) => n], ["asc"])
}

interface SkillSource {
  name: string
  sourceDir: string
  /** Lower-precedence roots that also define this skill and are ignored. */
  shadowedDirs: string[]
}

async function discoverSkillSources(skillsDirs: string[]): Promise<SkillSource[]> {
  const byName = new Map<string, Omit<SkillSource, "name">>()
  for (const sourceDir of skillsDirs) {
    for (const name of await discoverSkillNames(sourceDir)) {
      const existing = byName.get(name)
      if (existing) existing.shadowedDirs.push(sourceDir)
      else byName.set(name, { sourceDir, shadowedDirs: [] })
    }
  }
  return orderBy(
    [...byName].map(([name, source]) => ({ name, ...source })),
    [(entry) => entry.name],
    ["asc"]
  )
}

type AgentEntry = (typeof AGENTS)[number]

function resolveAgentPair(
  from: string,
  to: string
): { fromAgent: AgentEntry; toAgent: AgentEntry } {
  // --convert and --to-command apply tool-name remapping using the agent's
  // toolAliases, so pseudo-agents (e.g. "agents") aren't valid here. For
  // copy-only sync to the shared .agents/skills roots use --sync, which routes
  // through resolveForSync() and accepts the agents pseudo-target.
  // (Resolution for #662 and the migrated duplicate #663.)
  const fromAgent = getAgent(from)
  const toAgent = getAgent(to)
  const ids = AGENTS.map((a) => a.id).join(", ")
  if (!fromAgent) {
    if (PSEUDO_AGENTS[from]) {
      throw new Error(
        `--convert and --to-command do not support the "${from}" source (no tool aliases). Use --sync to copy skills from that location.`
      )
    }
    throw new Error(`Unknown agent: ${from}. Valid agent IDs: ${ids}`)
  }
  if (!toAgent) {
    if (PSEUDO_AGENTS[to]) {
      throw new Error(
        `--convert and --to-command do not support the "${to}" target (no tool aliases). Use --sync to copy skills to that location.`
      )
    }
    throw new Error(`Unknown agent: ${to}. Valid agent IDs: ${ids}`)
  }
  return { fromAgent, toAgent }
}

function logSkillAction(
  name: string,
  targetExists: boolean,
  dryRun: boolean,
  verb: string,
  dryVerb: string
): "new" | "overwrite" {
  const isOverwrite = targetExists
  const label = dryRun
    ? isOverwrite
      ? `would overwrite ${name}`
      : `would ${dryVerb} ${name}`
    : isOverwrite
      ? `overwritten ${name}`
      : `${verb} ${name}`
  console.log(`  - ${label}`)
  return isOverwrite ? "overwrite" : "new"
}

function printConversionSummary(opts: {
  converted: number
  overwritten: number
  skipped: number
  overwrite: boolean
  allUnmapped: Set<string>
  agentName: string
}): void {
  const { converted, overwritten, skipped, overwrite, allUnmapped, agentName } = opts
  console.log(
    `\nSummary: ${converted} converted, ${overwritten} overwritten, ${skipped} skipped` +
      (!overwrite && skipped > 0 ? " (use --overwrite to replace existing targets)" : "")
  )
  printUnmappedWarning(allUnmapped, agentName)
}

function printUnmappedWarning(allUnmapped: Set<string>, agentName: string): void {
  if (allUnmapped.size === 0) return
  console.log(
    `⚠ Unmapped tool names (no equivalent in ${agentName}): ${[...allUnmapped].join(", ")}`
  )
  console.log("  These tool names were preserved as-is. Review and update manually if needed.")
}

/** Convert skills from one agent to another (all skills, or a single named one). */
async function convertSkills(options: {
  from: string
  to: string
  dryRun: boolean
  overwrite: boolean
  name?: string
}): Promise<void> {
  const { from, to, dryRun, overwrite, name } = options
  const { fromAgent, toAgent } = resolveAgentPair(from, to)
  const fromSkillsDir = primarySkillDir(from)
  const toSkillsDir = primarySkillDir(to)
  const orderedSkillNames = name
    ? [await requireSkillName(fromSkillsDir, name)]
    : await discoverSkillNames(fromSkillsDir)

  if (orderedSkillNames.length === 0) {
    console.log(`No ${fromAgent.name} skills with SKILL.md found at ${displayPath(fromSkillsDir)}.`)
    return
  }

  console.log(
    dryRun
      ? `Dry run: converting ${fromAgent.name} → ${toAgent.name} skills (no files will be written).`
      : `Converting ${fromAgent.name} → ${toAgent.name} skills.`
  )
  if (!dryRun) await mkdir(toSkillsDir, { recursive: true })
  console.log(`Source: ${displayPath(fromSkillsDir)}`)
  console.log(`Target: ${displayPath(toSkillsDir)}\n`)

  let converted = 0,
    overwritten = 0,
    skipped = 0
  const allUnmapped = new Set<string>()

  for (const name of orderedSkillNames) {
    const targetDir = join(toSkillsDir, name)
    const targetExists = existsSync(targetDir)
    if (targetExists && !overwrite) {
      skipped++
      console.log(`  - skipped ${name} (already exists)`)
      continue
    }

    const result = await convertSingleSkill({ fromSkillsDir, name, targetDir, from, to, dryRun })
    for (const u of result.unmapped) allUnmapped.add(u)
    const kind = logSkillAction(
      name + result.warnSuffix,
      targetExists,
      dryRun,
      "converted",
      "convert"
    )
    if (kind === "overwrite") overwritten++
    else converted++
  }

  printConversionSummary({
    converted,
    overwritten,
    skipped,
    overwrite,
    allUnmapped,
    agentName: toAgent.name,
  })
}

function emptySyncCounts(): Record<SkillSyncAction, number> {
  return { copied: 0, updated: 0, overwritten: 0, unchanged: 0, skipped: 0, removed: 0 }
}

function printSyncSummary(
  counts: Record<SkillSyncAction, number>,
  failed: number,
  overwrite: boolean
): void {
  const { copied, updated, overwritten, unchanged, skipped, removed } = counts
  console.log(
    `\nSummary: ${copied} copied, ${updated} updated, ${overwritten} overwritten, ${unchanged} unchanged, ${skipped} skipped` +
      (removed > 0 ? `, ${removed} removed` : "") +
      (failed > 0 ? `, ${failed} failed` : "") +
      (!overwrite && skipped > 0
        ? " (use --overwrite to replace targets with unresolved conflicts)"
        : "")
  )
}

export interface SkillSyncFileSystem {
  copyDirectory(sourceDir: string, targetDir: string): Promise<void>
  createTemporaryDirectory(prefix: string): Promise<string>
  isFile(path: string): Promise<boolean>
  moveDirectory(sourceDir: string, targetDir: string): Promise<void>
  removeDirectory(path: string): Promise<void>
  /** Move a skill deleted elsewhere to the Trash; false when it could not be moved. */
  trashDirectory(path: string): Promise<boolean>
}

const DEFAULT_SKILL_SYNC_FILE_SYSTEM: SkillSyncFileSystem = {
  async copyDirectory(sourceDir, targetDir) {
    // Copy links as links and retain source timestamps/modes in the staged tree.
    await cp(sourceDir, targetDir, {
      recursive: true,
      force: true,
      dereference: false,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    })
  },
  createTemporaryDirectory(prefix) {
    return mkdtemp(prefix)
  },
  async isFile(path) {
    return (await stat(path)).isFile()
  },
  moveDirectory(sourceDir, targetDir) {
    return rename(sourceDir, targetDir)
  },
  async removeDirectory(path) {
    await rm(path, { recursive: true, force: true })
  },
  trashDirectory(path) {
    return defaultTrashPath(path)
  },
}

function resolveSkillSyncFileSystem(
  overrides: Partial<SkillSyncFileSystem> = {}
): SkillSyncFileSystem {
  return { ...DEFAULT_SKILL_SYNC_FILE_SYSTEM, ...overrides }
}

async function safelyRemoveDirectory(path: string, fileSystem: SkillSyncFileSystem): Promise<void> {
  try {
    await fileSystem.removeDirectory(path)
  } catch {
    // Cleanup must not mask the copy/swap error that left the old target recoverable.
  }
}

async function replaceSkillDirectory(
  targetDir: string,
  options: {
    allowReplace: boolean
    fileSystem?: Partial<SkillSyncFileSystem>
    /** Populate the staged replacement directory. */
    stage: (replacementDir: string, fileSystem: SkillSyncFileSystem) => Promise<void>
  }
): Promise<void> {
  const fileSystem = resolveSkillSyncFileSystem(options.fileSystem)
  const targetParent = dirname(targetDir)
  const targetName = basename(targetDir)
  const stagingRoot = await fileSystem.createTemporaryDirectory(
    join(targetParent, `.${targetName}.sync-`)
  )
  const replacementDir = join(stagingRoot, "replacement")
  let backupRoot: string | null = null
  let preserveBackup = false

  try {
    await options.stage(replacementDir, fileSystem)
    if (!(await fileSystem.isFile(join(replacementDir, "SKILL.md")))) {
      throw new Error(`Copied skill ${targetName} is missing a valid SKILL.md.`)
    }

    if (!existsSync(targetDir)) {
      await fileSystem.moveDirectory(replacementDir, targetDir)
      return
    }
    // The target was absent when sync decided to copy, but appeared while staging.
    if (!options.allowReplace) {
      throw new Error(
        `${targetName} appeared in the target while syncing; rerun with --overwrite to replace it.`
      )
    }

    backupRoot = await fileSystem.createTemporaryDirectory(
      join(targetParent, `.${targetName}.backup-`)
    )
    const backupDir = join(backupRoot, "previous")
    await fileSystem.moveDirectory(targetDir, backupDir)

    try {
      await fileSystem.moveDirectory(replacementDir, targetDir)
    } catch (installError) {
      try {
        await fileSystem.moveDirectory(backupDir, targetDir)
      } catch (restoreError) {
        preserveBackup = true
        throw new Error(
          `Failed to install replacement for ${targetName} and restore the previous target. ` +
            `The previous target remains recoverable at ${backupDir}. ` +
            `Install error: ${messageFromUnknownError(installError)}. ` +
            `Restore error: ${messageFromUnknownError(restoreError)}.`
        )
      }
      throw installError
    }

    await fileSystem.removeDirectory(backupRoot)
    backupRoot = null
  } finally {
    await safelyRemoveDirectory(stagingRoot, fileSystem)
    if (backupRoot && !preserveBackup) {
      await safelyRemoveDirectory(backupRoot, fileSystem)
    }
  }
}

/** Whether two same-kind entries hold the same link target, or the same bytes and mode. */
async function skillTreeEntriesMatch(
  sourcePath: string,
  targetPath: string,
  kind: SkillTreeEntryKind
): Promise<boolean> {
  if (kind === "directory") return true
  if (kind === "symlink") return (await readlink(sourcePath)) === (await readlink(targetPath))
  const [sourceStat, targetStat] = await Promise.all([lstat(sourcePath), lstat(targetPath)])
  if (sourceStat.size !== targetStat.size) return false
  if ((sourceStat.mode & 0o777) !== (targetStat.mode & 0o777)) return false
  const [sourceBytes, targetBytes] = await Promise.all([
    Bun.file(sourcePath).bytes(),
    Bun.file(targetPath).bytes(),
  ])
  return Buffer.from(sourceBytes).equals(targetBytes)
}

interface SkillTreeDiff {
  added: string[]
  modified: string[]
  removed: string[]
}

async function diffSkillTrees(sourceDir: string, targetDir: string): Promise<SkillTreeDiff> {
  const [sourceEntries, targetEntries] = await Promise.all([
    collectSkillTreeEntries(sourceDir),
    collectSkillTreeEntries(targetDir),
  ])
  const label = (path: string, kind: SkillTreeEntryKind) =>
    kind === "directory" ? `${path}/` : path
  const diff: SkillTreeDiff = { added: [], modified: [], removed: [] }
  for (const [path, kind] of targetEntries) {
    const sourceKind = sourceEntries.get(path)
    if (sourceKind === undefined) diff.removed.push(label(path, kind))
    else if (sourceKind !== kind) diff.modified.push(label(path, sourceKind))
    else if (!(await skillTreeEntriesMatch(join(sourceDir, path), join(targetDir, path), kind))) {
      diff.modified.push(label(path, kind))
    }
  }
  for (const [path, kind] of sourceEntries) {
    if (!targetEntries.has(path)) diff.added.push(label(path, kind))
  }
  diff.added.sort()
  diff.modified.sort()
  diff.removed.sort()
  return diff
}

function describeSkillTreeDiff(diff: SkillTreeDiff): string {
  const parts = [
    diff.added.length > 0 ? `${diff.added.length} added` : "",
    diff.modified.length > 0 ? `${diff.modified.length} modified` : "",
    diff.removed.length > 0 ? `${diff.removed.length} removed` : "",
  ].filter(Boolean)
  return parts.join(", ")
}

function printSkillTreeDiff(name: string, diff: SkillTreeDiff): void {
  for (const path of diff.added) console.log(`    - would add ${name}/${path}`)
  for (const path of diff.modified) console.log(`    - would update ${name}/${path}`)
  for (const path of diff.removed) console.log(`    - would remove ${name}/${path}`)
}

type SkillSyncAction = "copied" | "updated" | "overwritten" | "unchanged" | "skipped" | "removed"

/** Builds the evidence context for one skill's source and target directories. */
type SkillContextFactory = (sourceSkillDir: string, targetDir: string) => SkillResolutionContext

interface SkillSyncOptions {
  targetRoot: string
  dryRun: boolean
  overwrite: boolean
  fileSystem?: Partial<SkillSyncFileSystem>
  createContext: SkillContextFactory
  /** Omit lines for skills that need no change (watch mode re-checks every settled skill). */
  quiet?: boolean
}

interface SingleSkillSync extends SkillSyncOptions {
  name: string
  sourceSkillDir: string
  targetDir: string
}

const FILE_RESOLUTION_VERBS: Partial<Record<SkillFileResolutionKind, string>> = {
  "source-newer": "update",
  merged: "merge",
  added: "add",
  "target-newer": "keep",
  diverged: "conflict",
}

function printFileResolutions(
  name: string,
  files: SkillFileResolution[],
  kinds: SkillFileResolutionKind[]
): void {
  for (const file of files) {
    if (!kinds.includes(file.kind)) continue
    console.log(`    - ${FILE_RESOLUTION_VERBS[file.kind]} ${name}/${file.path}: ${file.reason}`)
  }
}

async function writeResolvedFile(write: SkillFileWrite, destination: string): Promise<void> {
  if ("content" in write) {
    await Bun.write(destination, write.content)
    return
  }
  // Keep the source mtime so later syncs still order the two sides correctly.
  await cp(write.copyFrom, destination, { force: true, preserveTimestamps: true })
}

/** Stage the current target plus resolved writes; target-only and newer target files survive. */
async function stageSkillUpdate(
  targetDir: string,
  replacementDir: string,
  files: SkillFileResolution[],
  fileSystem: SkillSyncFileSystem
): Promise<void> {
  await fileSystem.copyDirectory(targetDir, replacementDir)
  for (const file of files) {
    if (!file.write) continue
    const destination = join(replacementDir, file.path)
    await mkdir(dirname(destination), { recursive: true })
    await writeResolvedFile(file.write, destination)
  }
}

/** Stage a whole-skill copy of the source with its markdown in the target's tool names. */
function stageConvertedCopy(sourceSkillDir: string, converted: Map<string, string>) {
  return async (replacementDir: string, fs: SkillSyncFileSystem): Promise<void> => {
    await fs.copyDirectory(sourceSkillDir, replacementDir)
    for (const [path, content] of converted) {
      await Bun.write(join(replacementDir, path), content)
    }
  }
}

function printConversions(name: string, converted: Map<string, string>, dryRun: boolean): void {
  for (const path of [...converted.keys()].sort()) {
    console.log(
      `    - ${dryRun ? "would convert" : "converted"} ${name}/${path} to target tool names`
    )
  }
}

async function copyNewSkill(sync: SingleSkillSync): Promise<SkillSyncAction> {
  const { name, sourceSkillDir, targetDir, dryRun, overwrite, fileSystem } = sync
  const converted = await convertSourceMarkdown(sync.createContext(sourceSkillDir, targetDir))
  if (!dryRun) {
    await replaceSkillDirectory(targetDir, {
      allowReplace: overwrite,
      fileSystem,
      stage: stageConvertedCopy(sourceSkillDir, converted),
    })
  }
  logSkillAction(name, false, dryRun, "copied", "copy")
  printConversions(name, converted, dryRun)
  return "copied"
}

function reportResolvedUnchanged(
  name: string,
  files: SkillFileResolution[],
  quiet = false
): SkillSyncAction {
  if (quiet) return "unchanged"
  const summary = describeSkillResolution(files, ["equivalent", "target-newer", "target-only"])
  console.log(`  - unchanged ${name}${summary ? ` (${summary})` : ""}`)
  printFileResolutions(name, files, ["target-newer"])
  return "unchanged"
}

async function applyResolvedUpdate(
  sync: SingleSkillSync,
  files: SkillFileResolution[]
): Promise<SkillSyncAction> {
  const { name, targetDir, dryRun, fileSystem } = sync
  if (!dryRun) {
    await replaceSkillDirectory(targetDir, {
      allowReplace: true,
      fileSystem,
      stage: (replacementDir, fs) => stageSkillUpdate(targetDir, replacementDir, files, fs),
    })
  }
  const summary = describeSkillResolution(files, ["source-newer", "merged", "added"])
  console.log(`  - ${dryRun ? "would update" : "updated"} ${name} (${summary})`)
  printFileResolutions(name, files, ["source-newer", "merged", "added", "target-newer"])
  return "updated"
}

/** Unresolved conflicts keep the target unless --overwrite replaces it with the source. */
async function settleConflict(
  sync: SingleSkillSync,
  files: SkillFileResolution[],
  diff: SkillTreeDiff
): Promise<SkillSyncAction> {
  const { name, sourceSkillDir, targetDir, dryRun, overwrite, fileSystem } = sync
  const label = `${name} (${describeSkillTreeDiff(diff)})`
  if (!overwrite) {
    console.log(`  - skipped ${name} (target differs: ${describeSkillTreeDiff(diff)})`)
    printFileResolutions(name, files, ["diverged"])
    return "skipped"
  }
  const converted = await convertOverwriteMarkdown(sync.createContext(sourceSkillDir, targetDir))
  if (!dryRun) {
    await replaceSkillDirectory(targetDir, {
      allowReplace: true,
      fileSystem,
      stage: stageConvertedCopy(sourceSkillDir, converted),
    })
  }
  logSkillAction(label, true, dryRun, "copied", "copy")
  if (dryRun) printSkillTreeDiff(name, diff)
  printConversions(name, converted, dryRun)
  return "overwritten"
}

async function syncSingleSkill(sync: SingleSkillSync): Promise<SkillSyncAction> {
  const { name, sourceSkillDir, targetDir } = sync
  if (!existsSync(targetDir)) return await copyNewSkill(sync)
  const diff = await diffSkillTrees(sourceSkillDir, targetDir)
  if (!describeSkillTreeDiff(diff)) {
    if (!sync.quiet) console.log(`  - unchanged ${name}`)
    return "unchanged"
  }
  const plan = await planSkillResolution(sync.createContext(sourceSkillDir, targetDir))
  if (plan.outcome === "unchanged") return reportResolvedUnchanged(name, plan.files, sync.quiet)
  if (plan.outcome === "update") return await applyResolvedUpdate(sync, plan.files)
  return await settleConflict(sync, plan.files, diff)
}

/** Sync one skill, recording a failure instead of aborting the remaining skills. */
async function syncSkillSource(
  source: SkillSource,
  options: SkillSyncOptions
): Promise<SkillSyncAction | { failure: string }> {
  const { name, sourceDir, shadowedDirs } = source
  let result: SkillSyncAction | { failure: string }
  try {
    result = await syncSingleSkill({
      ...options,
      name,
      sourceSkillDir: join(sourceDir, name),
      targetDir: join(options.targetRoot, name),
    })
  } catch (error) {
    console.log(`  - failed ${name}`)
    result = { failure: `${name}: ${messageFromUnknownError(error)}` }
  }
  for (const shadowedDir of shadowedDirs) {
    console.log(
      `    - ignored ${displayPath(join(shadowedDir, name))} (shadowed by ${displayPath(sourceDir)})`
    )
  }
  return result
}

/** Tool-name vocabulary a sync side writes in; the shared .agents roots use Claude's names. */
function vocabularyAgent(id: string): AgentDef {
  return getAgent(id) ?? getAgent("claude")!
}

/**
 * Evidence sources for resolving existing targets. When neither side is the
 * Claude skills checkout, its history is consulted as a reference: a side's own
 * checkout may be a stale clone whose commits describe content it no longer holds.
 */
function createSkillContextFactory(
  from: string,
  to: string,
  baselines?: Map<string, SkillHistory>
): SkillContextFactory {
  const source = vocabularyAgent(from)
  const target = vocabularyAgent(to)
  const vocabulary = createSkillVocabulary(source, target)
  const referenceRoot = from === "claude" || to === "claude" ? null : primarySkillDir("claude")
  const reference = getAgent("claude")!
  return (sourceSkillDir, targetDir) => ({
    sourceDir: sourceSkillDir,
    targetDir,
    sourceHistory: lazySkillHistory(sourceSkillDir),
    targetHistory: lazySkillHistory(targetDir),
    vocabulary,
    reference: referenceRoot
      ? createSkillReferenceHistory(
          lazySkillHistory(join(referenceRoot, basename(targetDir))),
          reference,
          { source, target }
        )
      : undefined,
    baseline: baselines?.get(sourceSkillDir),
    targetBaseline: baselines?.get(targetDir),
  })
}

interface SkillTransferOptions {
  from: string
  to: string
  dryRun: boolean
  overwrite: boolean
  fileSystem?: Partial<SkillSyncFileSystem>
  project?: { root: string; name?: string; all: boolean }
}

async function resolveSkillTransfer(options: SkillTransferOptions) {
  const { from, to } = options
  const fromSkillsDirs = options.project ? userSkillDirs(from) : sourceSkillDirs(from)
  const toSkillsDir = options.project
    ? projectSkillDir(options.project.root, to)
    : primarySkillDir(to)
  const sources = await discoverSkillSources(fromSkillsDirs)
  const orderedSkills = options.project
    ? await selectProjectSkills(sources, toSkillsDir, options.project)
    : sources
  if (options.project) {
    await validateProjectSyncPaths(toSkillsDir, orderedSkills)
  }
  return { fromSkillsDirs, toSkillsDir, orderedSkills }
}

// New skills are converted to the target's tool names; existing targets resolve per file.
async function syncSkills(options: SkillTransferOptions): Promise<void> {
  const { from, to, dryRun, overwrite, fileSystem } = options
  const fromAgent = resolveForSync(from)
  const toAgent = resolveForSync(to)
  const { fromSkillsDirs, toSkillsDir, orderedSkills } = await resolveSkillTransfer(options)

  if (orderedSkills.length === 0) {
    console.log(
      options.project
        ? "No matching user skills to sync into the project."
        : `No ${fromAgent.name} skills with SKILL.md found at ${fromSkillsDirs.map(displayPath).join(", ")}.`
    )
    return
  }

  console.log(
    dryRun
      ? `Dry run: syncing ${fromAgent.name} → ${toAgent.name} skills (no files will be changed).`
      : `Syncing ${fromAgent.name} → ${toAgent.name} skills.`
  )
  if (!dryRun) await mkdir(toSkillsDir, { recursive: true })
  console.log(`Sources: ${fromSkillsDirs.map(displayPath).join(" > ")}`)
  console.log(`Target: ${displayPath(toSkillsDir)}\n`)

  const counts = emptySyncCounts()
  const failures: string[] = []
  const createContext = createSkillContextFactory(from, to)

  for (const source of orderedSkills) {
    const result = await syncSkillSource(source, {
      targetRoot: toSkillsDir,
      dryRun,
      overwrite,
      fileSystem,
      createContext,
    })
    if (typeof result === "string") counts[result]++
    else failures.push(result.failure)
  }

  printSyncSummary(counts, failures.length, overwrite)
  if (failures.length > 0) {
    throw new Error(
      `Failed to sync ${failures.length} skill(s):\n${failures.map((f) => `  - ${f}`).join("\n")}`
    )
  }
}

/** Project imports must never pick up a project override as their user source. */
function userSkillDirs(agent: string): string[] {
  return agent === "agents"
    ? [getAgentsSkillDir(), getLegacyAgentsSkillDir()]
    : (getProviderAdapter(agent)?.getSkillDirs() ?? [primarySkillDir(agent)])
}

function projectSkillDir(root: string, agent: string): string {
  return join(root, `.${agent === "antigravity" ? "gemini" : agent}`, "skills")
}

/** A project import must not write through links into user or unrelated directories. */
async function validateProjectSyncPaths(targetRoot: string, sources: SkillSource[]): Promise<void> {
  for (const path of [dirname(targetRoot), targetRoot]) {
    const info = await lstat(path).catch((error) => {
      if (error.code === "ENOENT") return null
      throw error
    })
    if (info?.isSymbolicLink()) throw new Error(`Project sync does not support symlinks: ${path}`)
  }
  for (const source of sources) {
    for (const path of [join(source.sourceDir, source.name), join(targetRoot, source.name)]) {
      const info = await lstat(path).catch((error) => {
        if (error.code === "ENOENT") return null
        throw error
      })
      if (!info) continue
      const entries = await collectSkillTreeEntries(path)
      if (info.isSymbolicLink() || [...entries.values()].includes("symlink")) {
        throw new Error(`Project sync does not support symlinked skill trees: ${path}`)
      }
    }
  }
}

async function selectProjectSkills(
  sources: SkillSource[],
  targetRoot: string,
  selection: { name?: string; all: boolean }
): Promise<SkillSource[]> {
  if (selection.name) {
    const source = sources.find((entry) => entry.name === selection.name)
    if (!source) throw new Error(`User skill not found: ${selection.name}.`)
    return [source]
  }
  if (selection.all) return sources
  const selected = new Set(await discoverSkillNames(targetRoot))
  const available = new Set(sources.map((source) => source.name))
  for (const name of selected) {
    if (!available.has(name)) console.log(`  - kept ${name} (project-only; no user source)`)
  }
  if (selected.size === 0) {
    console.log("No project skills selected. Pass a skill name or --all to import user skills.")
  }
  return sources.filter((source) => selected.has(source.name))
}

/** Highest-precedence source of one skill, or null when no source root defines it. */
async function findSkillSource(skillsDirs: string[], name: string): Promise<SkillSource | null> {
  const dirs: string[] = []
  for (const dir of skillsDirs) {
    if (await Bun.file(join(dir, name, "SKILL.md")).exists()) dirs.push(dir)
  }
  const [sourceDir, ...shadowedDirs] = dirs
  return sourceDir ? { name, sourceDir, shadowedDirs } : null
}

/** Abort on SIGTERM, SIGINT, or the caller's signal; dispose removes the process listeners. */
function watchStopSignal(callerSignal?: AbortSignal): {
  signal: AbortSignal
  dispose: () => void
} {
  const controller = new AbortController()
  const stop = () => controller.abort()
  // Keep the CLI's immediate-exit handler from cutting a skill swap short.
  const releaseClaim = claimShutdownSignals()
  process.on("SIGTERM", stop)
  process.on("SIGINT", stop)
  if (callerSignal?.aborted) stop()
  callerSignal?.addEventListener("abort", stop, { once: true })
  return {
    signal: controller.signal,
    dispose: () => {
      process.off("SIGTERM", stop)
      process.off("SIGINT", stop)
      callerSignal?.removeEventListener("abort", stop)
      releaseClaim()
    },
  }
}

interface SkillSyncWatchSettings {
  quietMs?: number
  sweepMs?: number
  signal?: AbortSignal
}

// Long-running --sync-watch: each skill syncs (with the same per-file resolution as --sync)
// only after it has been still on both sides for the quiet window.
async function watchSyncSkills(options: {
  from: string
  to: string
  dryRun: boolean
  overwrite: boolean
  fileSystem?: Partial<SkillSyncFileSystem>
  watch: SkillSyncWatchSettings
}): Promise<void> {
  const { from, to, dryRun, overwrite, fileSystem } = options
  const fromAgent = resolveForSync(from)
  const toAgent = resolveForSync(to)
  const fromSkillsDirs = sourceSkillDirs(from)
  const toSkillsDir = primarySkillDir(to)
  const quietMs = options.watch.quietMs ?? DEFAULT_SKILL_SYNC_QUIET_MS
  const baselines = new Map<string, SkillHistory>()
  if (!dryRun) await mkdir(toSkillsDir, { recursive: true })

  console.log(
    `Watching ${fromAgent.name} → ${toAgent.name} skills${dryRun ? " (dry run: no files will be changed)" : ""}.`
  )
  console.log(`Sources: ${fromSkillsDirs.map(displayPath).join(" > ")}`)
  console.log(`Target: ${displayPath(toSkillsDir)}`)
  console.log(
    `Each skill syncs after ${quietMs / 1000}s with no changes on either side. Stop with Ctrl+C or SIGTERM.\n`
  )

  const syncOptions: SkillSyncOptions = {
    targetRoot: toSkillsDir,
    dryRun,
    overwrite,
    fileSystem,
    createContext: createSkillContextFactory(from, to, baselines),
    quiet: true,
  }
  const stop = watchStopSignal(options.watch.signal)
  try {
    await watchSkillSync({
      sourceRoots: fromSkillsDirs,
      targetRoot: toSkillsDir,
      quietMs,
      sweepMs: options.watch.sweepMs ?? quietMs * 3,
      signal: stop.signal,
      listSkills: async () => (await discoverSkillSources(fromSkillsDirs)).map((s) => s.name),
      syncSkill: async (name) => {
        const source = await findSkillSource(fromSkillsDirs, name)
        if (!source) return
        const result = await syncSkillSource(source, syncOptions)
        if (typeof result !== "string") console.log(`    ${result.failure}`)
        // The source as just synced is the base for resolving the next round of edits.
        const sourceSkillDir = join(source.sourceDir, name)
        baselines.set(sourceSkillDir, await snapshotSkillBaseline(sourceSkillDir))
      },
      log: (message) => console.log(`  - ${message}`),
    })
  } finally {
    stop.dispose()
  }
  console.log("\nStopped watching.")
}

// ─── Automatic-direction sync across agent skill roots ───────────────────────
//
// The hub (Claude's skills checkout unless --agents names another first) is
// reconciled with every spoke root in both directions: newer spoke edits flow
// into the hub, then newer hub content — including what just arrived — flows out
// to every spoke. Each file's direction comes from the same evidence as --sync.

interface SkillSyncRoot {
  id: string
  name: string
  dir: string
  vocabulary: AgentDef
}

function physicalPath(path: string): string {
  return existsSync(path) ? realpathSync(path) : path
}

/** Hub first; agents sharing one skills directory (gemini/antigravity) are synced once. */
function resolveSyncRoots(agentsArg: string | null): SkillSyncRoot[] {
  const ids =
    agentsArg === null
      ? ["claude", ...AGENTS.map((a) => a.id).filter((id) => id !== "claude")]
      : agentsArg
          .split(",")
          .map((id) => id.trim())
          .filter(Boolean)
  const roots: SkillSyncRoot[] = []
  const seen = new Set<string>()
  for (const id of ids) {
    const { name } = resolveForSync(id)
    const dir = primarySkillDir(id)
    const physical = physicalPath(dir)
    // By default only roots that exist join; an explicit list may create them.
    if (seen.has(physical) || (agentsArg === null && roots.length > 0 && !existsSync(dir))) continue
    seen.add(physical)
    roots.push({ id, name, dir, vocabulary: vocabularyAgent(id) })
  }
  if (roots.length < 2) {
    throw new Error(
      "Automatic sync needs at least two skill roots; pass --agents <hub>,<agent>[,...]."
    )
  }
  return roots
}

async function listSkillsAcrossRoots(
  roots: SkillSyncRoot[],
  state?: SkillSyncState
): Promise<string[]> {
  const names = new Set<string>()
  for (const root of roots) {
    for (const name of await discoverSkillNames(root.dir)) names.add(name)
    for (const name of Object.keys(state?.roots[root.dir] ?? {})) names.add(name)
  }
  return [...names].sort()
}

function hasSkill(root: SkillSyncRoot, name: string): Promise<boolean> {
  return Bun.file(join(root.dir, name, "SKILL.md")).exists()
}

/** Copy a skill into a root that lacks it, converted into that agent's tool names. */
async function stageConvertedSkillCopy(
  sourceSkillDir: string,
  replacementDir: string,
  vocabulary: { from: AgentDef; to: AgentDef },
  fileSystem: SkillSyncFileSystem
): Promise<void> {
  await fileSystem.copyDirectory(sourceSkillDir, replacementDir)
  if (vocabulary.from.id === vocabulary.to.id) return
  for (const [path, kind] of await collectSkillTreeEntries(replacementDir)) {
    if (kind !== "file" || !path.endsWith(".md")) continue
    const file = join(replacementDir, path)
    const text = await Bun.file(file).text()
    const converted = convertSkillContent(text, vocabulary.from, vocabulary.to, AGENTS).content
    if (converted !== text) await Bun.write(file, converted)
  }
}

interface RootSyncSettings {
  dryRun: boolean
  quiet: boolean
  fileSystem?: Partial<SkillSyncFileSystem>
  /** Per-skill-directory snapshots from the last pass (watch mode only). */
  baselines?: Map<string, SkillHistory>
  /** What each root held after the last pass, so deletions are carried rather than undone. */
  state: SkillSyncState
  /** Roots judged reset (mass disappearance) and still being restored. */
  resetRoots?: Set<string>
}

function resolvedFileSystem(settings: RootSyncSettings): SkillSyncFileSystem {
  return resolveSkillSyncFileSystem(settings.fileSystem)
}

/** More skills than this vanishing from one root at once reads as a reset, not deletions. */
const MASS_DELETION_LIMIT = 5

/**
 * A root that is missing, or lost more than MASS_DELETION_LIMIT of the skills it held after
 * the last pass, was most likely wiped, moved, or reinstalled. Its absences are not carried
 * as deletions — the normal pass copies the skills back into it instead.
 */
async function looksReset(root: SkillSyncRoot, settings: RootSyncSettings): Promise<boolean> {
  const missing = await countMissingRecordedSkills(root, settings)
  settings.resetRoots ??= new Set()
  // Once judged reset, a root stays so until every missing skill is back: restoring them
  // one by one must not shrink the count under the limit and turn the rest into deletions.
  if (settings.resetRoots.has(root.dir)) {
    if (missing > 0) return true
    settings.resetRoots.delete(root.dir)
    return false
  }
  if (missing <= MASS_DELETION_LIMIT) return false
  settings.resetRoots.add(root.dir)
  console.log(
    `  - not carrying deletions from ${root.id}: ${missing} skills are missing from ${displayPath(root.dir)} at once, which looks like a reset; restoring them there instead. To remove skills in bulk, stop the watch first and delete them from every root.`
  )
  return true
}

async function countMissingRecordedSkills(
  root: SkillSyncRoot,
  settings: RootSyncSettings
): Promise<number> {
  const recordedNames = Object.keys(settings.state.roots[root.dir] ?? {})
  if (!existsSync(root.dir)) return recordedNames.length
  let missing = 0
  for (const name of recordedNames) {
    if (!(await hasSkill(root, name))) missing++
  }
  return missing
}

/**
 * A skill missing from a root that held it after the last pass was deleted there. When
 * every remaining copy is unchanged since that pass, carry the deletion (to the Trash);
 * when any copy was edited since, the edit wins and the normal pass restores the skill.
 * Returns the actions taken, or null when the skill should sync normally.
 */
async function retireDeletedSkill(
  name: string,
  roots: SkillSyncRoot[],
  settings: RootSyncSettings
): Promise<SkillSyncAction[] | null> {
  const present = await Promise.all(roots.map((root) => hasSkill(root, name)))
  const recorded = roots.map((root) => settings.state.roots[root.dir]?.[name])
  const deletedFrom = roots.filter((_, i) => !present[i] && recorded[i] !== undefined)
  const remaining = roots.filter((_, i) => present[i])
  if (deletedFrom.length === 0 || remaining.length === 0) return null
  for (const root of deletedFrom) {
    if (await looksReset(root, settings)) return null
  }
  const deletedIds = deletedFrom.map((root) => root.id).join(", ")
  const editedIn = await firstChangedSinceSync(name, remaining, settings)
  if (editedIn) {
    console.log(
      `  - restoring ${name}: deleted from ${deletedIds}, but ${editedIn.id} changed it since the last sync`
    )
    return null
  }
  const fileSystem = resolvedFileSystem(settings)
  for (const root of remaining) {
    const skillDir = join(root.dir, name)
    if (!settings.dryRun && !(await fileSystem.trashDirectory(skillDir))) {
      throw new Error(`Could not move ${displayPath(skillDir)} to the Trash`)
    }
    console.log(
      `  - ${settings.dryRun ? "would remove" : "removed"} ${root.id}/${name} (deleted from ${deletedIds})`
    )
  }
  return remaining.map(() => "removed" as const)
}

/** The first root whose copy of the skill differs from what it held after the last pass. */
async function firstChangedSinceSync(
  name: string,
  roots: SkillSyncRoot[],
  settings: RootSyncSettings
): Promise<SkillSyncRoot | null> {
  for (const root of roots) {
    const recorded = settings.state.roots[root.dir]?.[name]
    if ((await stampSkillDir(join(root.dir, name))) !== recorded) return root
  }
  return null
}

/** Record each root's copy after the pass; dry runs leave the state untouched. */
async function recordSkillState(
  name: string,
  roots: SkillSyncRoot[],
  settings: RootSyncSettings
): Promise<void> {
  if (settings.dryRun) return
  for (const root of roots) {
    const stamp = await stampSkillDir(join(root.dir, name))
    const entries = settings.state.roots[root.dir] ?? {}
    settings.state.roots[root.dir] = entries
    if (stamp) entries[name] = stamp
    else delete entries[name]
  }
}

async function copySkillAcross(
  name: string,
  roots: { from: SkillSyncRoot; to: SkillSyncRoot },
  settings: RootSyncSettings
): Promise<SkillSyncAction> {
  const { from, to } = roots
  if (!settings.dryRun) {
    await replaceSkillDirectory(join(to.dir, name), {
      allowReplace: false,
      fileSystem: settings.fileSystem,
      stage: (replacementDir, fs) =>
        stageConvertedSkillCopy(
          join(from.dir, name),
          replacementDir,
          { from: from.vocabulary, to: to.vocabulary },
          fs
        ),
    })
  }
  logSkillAction(`${from.id}→${to.id}/${name}`, false, settings.dryRun, "copied", "copy")
  return "copied"
}

/** Bring one skill from `from` into `to`, resolving per file when both roots have it. */
async function syncSkillDirection(
  name: string,
  roots: { from: SkillSyncRoot; to: SkillSyncRoot },
  settings: RootSyncSettings
): Promise<SkillSyncAction | null> {
  const { from, to } = roots
  const [inFrom, inTo] = await Promise.all([hasSkill(from, name), hasSkill(to, name)])
  if (!inFrom) return null
  if (!inTo) return await copySkillAcross(name, roots, settings)
  // A skill linked into both roots is one directory; there is nothing to reconcile.
  if (physicalPath(join(from.dir, name)) === physicalPath(join(to.dir, name))) return null
  return await syncSingleSkill({
    name: `${from.id}→${to.id}/${name}`,
    sourceSkillDir: join(from.dir, name),
    targetDir: join(to.dir, name),
    targetRoot: to.dir,
    dryRun: settings.dryRun,
    overwrite: false,
    quiet: settings.quiet,
    fileSystem: settings.fileSystem,
    createContext: createSkillContextFactory(from.id, to.id, settings.baselines),
  })
}

/**
 * Sync one skill across every root: first every spoke into the hub, then the hub out to
 * every spoke, so an edit in any root reaches all of them in one pass. Failures are
 * recorded per direction so the rest still sync.
 */
async function syncSkillAcrossRoots(
  name: string,
  roots: SkillSyncRoot[],
  settings: RootSyncSettings
): Promise<{ actions: SkillSyncAction[]; failures: string[] }> {
  const [hub, ...spokes] = roots as [SkillSyncRoot, ...SkillSyncRoot[]]
  const actions: SkillSyncAction[] = []
  const failures: string[] = []
  try {
    const removed = await retireDeletedSkill(name, roots, settings)
    if (removed) {
      await recordSkillState(name, roots, settings)
      return { actions: removed, failures }
    }
  } catch (error) {
    console.log(`  - failed to remove ${name}`)
    return { actions, failures: [`${name}: ${messageFromUnknownError(error)}`] }
  }
  const directions = [
    ...spokes.map((spoke) => ({ from: spoke, to: hub })),
    ...spokes.map((spoke) => ({ from: hub, to: spoke })),
  ]
  for (const direction of directions) {
    const label = `${direction.from.id}→${direction.to.id}/${name}`
    try {
      const action = await syncSkillDirection(name, direction, settings)
      if (action) actions.push(action)
    } catch (error) {
      console.log(`  - failed ${label}`)
      failures.push(`${label}: ${messageFromUnknownError(error)}`)
    }
  }
  await recordSkillState(name, roots, settings)
  if (settings.baselines) {
    // Every root as just settled is the merge base for the next round of edits.
    for (const root of roots) {
      const skillDir = join(root.dir, name)
      if (await hasSkill(root, name)) {
        settings.baselines.set(skillDir, await snapshotSkillBaseline(skillDir))
      }
    }
  }
  return { actions, failures }
}

function printRootsHeader(verb: string, roots: SkillSyncRoot[], dryRun: boolean): void {
  const [hub, ...spokes] = roots as [SkillSyncRoot, ...SkillSyncRoot[]]
  console.log(
    `${verb} skills between ${hub.name} (hub) and ${spokes.map((r) => r.name).join(", ")}; direction is resolved per file${dryRun ? " (dry run: no files will be changed)" : ""}.`
  )
  console.log(`Roots: ${roots.map((r) => `${r.id} ${displayPath(r.dir)}`).join(" | ")}`)
}

async function syncAllSkills(options: {
  agents: string | null
  dryRun: boolean
  fileSystem?: Partial<SkillSyncFileSystem>
}): Promise<void> {
  const { dryRun, fileSystem } = options
  const roots = resolveSyncRoots(options.agents)
  printRootsHeader("Syncing", roots, dryRun)
  console.log()
  if (!dryRun) for (const root of roots) await mkdir(root.dir, { recursive: true })

  const counts = emptySyncCounts()
  const failures: string[] = []
  const statePath = skillSyncStatePath()
  const settings: RootSyncSettings = {
    dryRun,
    quiet: false,
    fileSystem,
    state: await loadSkillSyncState(statePath),
  }
  // Skills the last pass saw are included so a deletion made since can be carried.
  for (const name of await listSkillsAcrossRoots(roots, settings.state)) {
    const result = await syncSkillAcrossRoots(name, roots, settings)
    for (const action of result.actions) counts[action]++
    failures.push(...result.failures)
  }
  if (!dryRun) await saveSkillSyncState(statePath, settings.state)
  // Counts are per direction. Conflicts have no --overwrite remedy here: that needs a direction.
  printSyncSummary(counts, failures.length, true)
  if (failures.length > 0) {
    throw new Error(
      `Failed to sync ${failures.length} skill(s):\n${failures.map((f) => `  - ${f}`).join("\n")}`
    )
  }
}

async function watchAllSkills(options: {
  agents: string | null
  dryRun: boolean
  fileSystem?: Partial<SkillSyncFileSystem>
  watch: SkillSyncWatchSettings
}): Promise<void> {
  const { dryRun, fileSystem } = options
  const roots = resolveSyncRoots(options.agents)
  const [hub, ...spokes] = roots as [SkillSyncRoot, ...SkillSyncRoot[]]
  const quietMs = options.watch.quietMs ?? DEFAULT_SKILL_SYNC_QUIET_MS
  if (!dryRun) for (const root of roots) await mkdir(root.dir, { recursive: true })
  printRootsHeader("Watching", roots, dryRun)
  console.log(
    `Each skill syncs after ${quietMs / 1000}s with no changes in any root. Stop with Ctrl+C or SIGTERM.\n`
  )

  const statePath = skillSyncStatePath()
  const settings: RootSyncSettings = {
    dryRun,
    quiet: true,
    fileSystem,
    baselines: new Map(),
    state: await loadSkillSyncState(statePath),
  }
  const stop = watchStopSignal(options.watch.signal)
  try {
    await watchSkillSync({
      sourceRoots: spokes.map((root) => root.dir),
      targetRoot: hub.dir,
      quietMs,
      sweepMs: options.watch.sweepMs ?? quietMs * 3,
      signal: stop.signal,
      listSkills: () => listSkillsAcrossRoots(roots, settings.state),
      syncSkill: async (name) => {
        const { failures } = await syncSkillAcrossRoots(name, roots, settings)
        for (const failure of failures) console.log(`    ${failure}`)
        if (!dryRun) await saveSkillSyncState(statePath, settings.state)
      },
      log: (message) => console.log(`  - ${message}`),
    })
  } finally {
    stop.dispose()
  }
  console.log("\nStopped watching.")
}

// ─── Flag parsing and routing ───────────────────────────────────────────────

async function exportSingleSkillToCommand(opts: {
  fromSkillsDir: string
  skillName: string
  targetFile: string
  targetExists: boolean
  fromAgent: AgentDef
  toAgent: AgentDef
  dryRun: boolean
  allUnmapped: Set<string>
}): Promise<"exported" | "overwritten"> {
  const original = await Bun.file(join(opts.fromSkillsDir, opts.skillName, "SKILL.md")).text()
  const { content: convertedContent, unmapped } = convertSkillContent(
    original,
    opts.fromAgent,
    opts.toAgent,
    AGENTS
  )
  const description = parseFrontmatterField(original, "description") || ""
  let convertedBody = stripFrontmatter(convertedContent).trim()

  // Transform skill variables to default command values
  convertedBody = eliminatePositionalArgs(convertedBody)
  convertedBody = unwrapInlineCommands(convertedBody)

  const frontmatter = ["---", `name: ${opts.skillName}`, `description: ${yamlScalar(description)}`]

  const allowedTools = extractMandatedSkillTools(convertedContent)
  if (allowedTools.length > 0) {
    frontmatter.push(`allowed-tools: ${allowedTools.join(", ")}`)
  }

  frontmatter.push("---")

  const commandContent = [...frontmatter, "", convertedBody, ""].join("\n")

  if (!opts.dryRun) {
    await Bun.write(opts.targetFile, commandContent)
  }

  for (const u of unmapped) opts.allUnmapped.add(u)
  const warnSuffix = unmapped.length > 0 ? ` [⚠ unmapped: ${unmapped.join(", ")}]` : ""
  const action = logSkillAction(
    `${opts.skillName}.md${warnSuffix}`,
    opts.targetExists,
    opts.dryRun,
    "exported",
    "export"
  )
  return action === "overwrite" ? "overwritten" : "exported"
}

async function prepareCommandExport(options: {
  commandsDir: string
  dryRun: boolean
  fromAgent: AgentDef
  fromSkillsDir: string
  orderedSkillNames: string[]
  toAgent: AgentDef
}): Promise<boolean> {
  if (options.orderedSkillNames.length === 0) {
    console.log(
      `No ${options.fromAgent.name} skills found at ${displayPath(options.fromSkillsDir)}..`
    )
    return false
  }
  console.log(
    options.dryRun
      ? `Dry run: exporting ${options.fromAgent.name} skills to ${options.toAgent.name} commands (no files will be written).`
      : `Exporting ${options.fromAgent.name} skills to ${options.toAgent.name} commands.`
  )
  if (!options.dryRun) await mkdir(options.commandsDir, { recursive: true })
  return true
}

async function exportCommand(options: {
  from: string
  to: string
  dryRun: boolean
  overwrite: boolean
  name?: string
}): Promise<void> {
  const { from, to, dryRun, overwrite, name } = options
  const { fromAgent, toAgent } = resolveAgentPair(from, to)

  const fromSkillsDir = primarySkillDir(from)
  const commandsDir = join(getHomeDir(), `.${toAgent.id}`, "commands")
  const orderedSkillNames = name
    ? [await requireSkillName(fromSkillsDir, name)]
    : await discoverSkillNames(fromSkillsDir)

  const ready = await prepareCommandExport({
    commandsDir,
    dryRun,
    fromAgent,
    fromSkillsDir,
    orderedSkillNames,
    toAgent,
  })
  if (!ready) return

  let exported = 0,
    overwritten = 0,
    skipped = 0
  const allUnmapped = new Set<string>()

  for (const skillName of orderedSkillNames) {
    const action = await exportSkillName({
      allUnmapped,
      commandsDir,
      dryRun,
      fromAgent,
      fromSkillsDir,
      overwrite,
      skillName,
      toAgent,
    })
    if (action === "skipped") skipped++
    else if (action === "overwritten") overwritten++
    else if (action === "exported") exported++
  }

  console.log(
    `\nSummary: ${exported} exported, ${overwritten} overwritten, ${skipped} skipped` +
      (!overwrite && skipped > 0 ? " (use --overwrite to replace existing targets)" : "")
  )
  printUnmappedWarning(allUnmapped, toAgent.name)
}

async function exportSkillName(options: {
  allUnmapped: Set<string>
  commandsDir: string
  dryRun: boolean
  fromAgent: AgentDef
  fromSkillsDir: string
  overwrite: boolean
  skillName: string
  toAgent: AgentDef
}): Promise<"exported" | "failed" | "overwritten" | "skipped"> {
  const targetFile = join(options.commandsDir, `${options.skillName}.md`)
  const targetExists = existsSync(targetFile)
  if (targetExists && !options.overwrite) {
    console.log(`  - skipped ${options.skillName} (already exists)`)
    return "skipped"
  }
  try {
    return await exportSingleSkillToCommand({
      fromSkillsDir: options.fromSkillsDir,
      skillName: options.skillName,
      targetFile,
      targetExists,
      fromAgent: options.fromAgent,
      toAgent: options.toAgent,
      dryRun: options.dryRun,
      allUnmapped: options.allUnmapped,
    })
  } catch (error) {
    console.log(`  - failed to export ${options.skillName}: ${messageFromUnknownError(error)}`)
    return "failed"
  }
}

function extractFlagValue(args: string[], flag: string): string | null {
  const idx = args.indexOf(flag)
  return idx >= 0 ? (args[idx + 1] ?? null) : null
}

function validateTransferExclusivity(selected: boolean[]): void {
  if (selected.filter(Boolean).length > 1) {
    throw new Error(
      "--sync, --sync-project, --sync-gemini, --sync-all, --sync-watch, --convert, and --to-command are mutually exclusive."
    )
  }
}

function projectFlagValue(args: string[], flag: string): string | null {
  const value = extractFlagValue(args, flag)
  if (args.includes(flag) && (!value || value.startsWith("--"))) {
    throw new Error(`${flag} requires a value.`)
  }
  return value
}

async function resolveSkillProject(args: string[]): Promise<string> {
  const requestedRoot = projectFlagValue(args, "--project")
  const root = requestedRoot ? resolve(requestedRoot) : findGitWorkTree(process.cwd())
  if (!root || !(await stat(root)).isDirectory()) {
    throw new Error(
      "--sync-project requires a project directory; pass --project <path> outside a Git repository."
    )
  }
  if (realpathSync(root) === realpathSync(getHomeDir())) {
    throw new Error("The project directory must differ from the user home directory.")
  }
  return root
}

async function handleSyncProject(
  args: string[],
  fileSystem?: Partial<SkillSyncFileSystem>
): Promise<void> {
  const from = projectFlagValue(args, "--from")
  if (!from) throw new Error("--sync-project requires --from <agent>.")
  const to = projectFlagValue(args, "--to") ?? from
  resolveForSync(from)
  resolveForSync(to)
  const root = await resolveSkillProject(args)
  const names = extractPositionals(args)
  if (names.length > 1 || (names.length > 0 && args.includes("--all"))) {
    throw new Error("--sync-project accepts one skill name or --all, not both.")
  }
  if (["--agents", "--install", "--uninstall"].some((flag) => args.includes(flag))) {
    throw new Error("--sync-project does not support --agents, --install, or --uninstall.")
  }
  await syncSkills({
    from,
    to,
    dryRun: args.includes("--dry-run"),
    overwrite: args.includes("--overwrite"),
    fileSystem,
    project: { root, name: names[0], all: args.includes("--all") },
  })
}

async function handleConvert(args: string[], dryRun: boolean, overwrite: boolean): Promise<void> {
  const from = extractFlagValue(args, "--from")
  const to = extractFlagValue(args, "--to")
  if (!from) throw new Error("--convert requires --from <agent>.")
  if (!to) throw new Error("--convert requires --to <agent>.")
  // The first positional is an optional single skill name to convert.
  const name = extractPositionals(args)[0]
  await convertSkills({ from, to, dryRun, overwrite, name })
}

async function handleToCommand(args: string[], dryRun: boolean, overwrite: boolean): Promise<void> {
  const from = extractFlagValue(args, "--from")
  if (!from) throw new Error("--to-command requires --from <agent>.")
  const to = extractFlagValue(args, "--to") ?? from

  // The first positional after removing flags is considered the specific skill name
  const name = extractPositionals(args)[0]

  await exportCommand({ from, to, dryRun, overwrite, name })
}

async function handleSync(
  args: string[],
  syncGemini: boolean,
  dryRun: boolean,
  overwrite: boolean,
  fileSystem?: Partial<SkillSyncFileSystem>
): Promise<void> {
  if (extractPositionals(args).length > 0)
    throw new Error("--sync/--sync-gemini does not accept a skill name.")
  const from = syncGemini ? "gemini" : extractFlagValue(args, "--from")
  if (!from) throw new Error("--sync requires --from <agent>.")
  const to = extractFlagValue(args, "--to") ?? "claude"
  await syncSkills({ from, to, dryRun, overwrite, fileSystem })
}

async function handleSyncWatch(
  args: string[],
  dryRun: boolean,
  overwrite: boolean,
  options?: SkillCommandOptions
): Promise<void> {
  if (extractPositionals(args).length > 0)
    throw new Error("--sync-watch does not accept a skill name.")
  if (args.includes("--install") || args.includes("--uninstall")) {
    await handleSyncWatchAgent(args, { dryRun, overwrite }, options?.launchAgent)
    return
  }
  const watch = {
    quietMs: options?.watchQuietMs,
    sweepMs: options?.watchSweepMs,
    signal: options?.watchSignal,
  }
  const fileSystem = options?.syncFileSystem
  if (args.includes("--from")) {
    await watchOneWay(args, { dryRun, overwrite, fileSystem, watch })
    return
  }
  const agents = automaticSyncAgents(args, overwrite, "--sync-watch")
  await watchAllSkills({ agents, dryRun, fileSystem, watch })
}

async function watchOneWay(
  args: string[],
  settings: {
    dryRun: boolean
    overwrite: boolean
    fileSystem?: Partial<SkillSyncFileSystem>
    watch: SkillSyncWatchSettings
  }
): Promise<void> {
  const from = extractFlagValue(args, "--from")
  if (!from) throw new Error("--from requires an <agent>.")
  if (args.includes("--agents")) {
    throw new Error("--agents selects automatic two-way sync; drop --from/--to to use it.")
  }
  const to = extractFlagValue(args, "--to") ?? "claude"
  await watchSyncSkills({ from, to, ...settings })
}

const SKILL_SYNC_AGENT_OUTCOMES: Record<LaunchAgentFileAction, [done: string, preview: string]> = {
  unsupported: ["not supported", "not supported"],
  unchanged: ["already installed and running", "already installed and running"],
  install: ["installed and started", "would be installed and started"],
  reload: ["updated and restarted", "would be updated and restarted"],
  load: ["started", "would be started"],
  remove: ["stopped and removed", "would be stopped and removed"],
}

/** Fail at install time, not at the next login, when the persisted arguments are invalid. */
function validateWatchArgs(watchArgs: string[], overwrite: boolean): void {
  const from = extractFlagValue(watchArgs, "--from")
  if (from) {
    resolveForSync(from)
    resolveForSync(extractFlagValue(watchArgs, "--to") ?? "claude")
    return
  }
  resolveSyncRoots(automaticSyncAgents(watchArgs, overwrite, "--sync-watch"))
}

/** `--sync-watch --install|--uninstall`: manage the login LaunchAgent that runs the watch. */
async function handleSyncWatchAgent(
  args: string[],
  flags: { dryRun: boolean; overwrite: boolean },
  agentOptions: SkillSyncAgentOptions = {}
): Promise<void> {
  if (args.includes("--install") && args.includes("--uninstall")) {
    throw new Error("--install and --uninstall are mutually exclusive.")
  }
  let action: LaunchAgentFileAction
  let watchArgs: string[] = []
  if (args.includes("--install")) {
    // --dry-run previews the install; it is not persisted into the agent.
    watchArgs = args.filter((arg) => !["--sync-watch", "--install", "--dry-run"].includes(arg))
    validateWatchArgs(watchArgs, flags.overwrite)
    action = await installSkillSyncLaunchAgent(watchArgs, flags.dryRun, agentOptions)
  } else {
    action = await uninstallSkillSyncLaunchAgent(flags.dryRun, agentOptions)
  }
  if (action === "unsupported") throw new Error("LaunchAgents are only available on macOS.")
  const [done, preview] = SKILL_SYNC_AGENT_OUTCOMES[action]
  console.log(`${SWIZ_SKILL_SYNC_LABEL}: ${flags.dryRun ? preview : done}`)
  if (action !== "remove") {
    console.log(`Runs at login: swiz skill --sync-watch ${watchArgs.join(" ")}`.trimEnd())
    console.log(
      `Logs: ${displayPath(join(agentOptions.homeDir ?? getHomeDir(), "Library/Logs/Swiz/skill-sync.log"))}`
    )
  }
}

/** --agents for automatic sync; --overwrite cannot apply because no side is "the source". */
function automaticSyncAgents(args: string[], overwrite: boolean, mode: string): string | null {
  if (overwrite) {
    throw new Error(
      `${mode} resolves direction per file, so --overwrite has no side to favour; use --sync --from <agent> --to <agent> --overwrite.`
    )
  }
  if (args.includes("--to")) throw new Error(`${mode} without --from does not take --to.`)
  return extractFlagValue(args, "--agents")
}

async function handleSyncAll(
  args: string[],
  dryRun: boolean,
  overwrite: boolean,
  fileSystem?: Partial<SkillSyncFileSystem>
): Promise<void> {
  if (extractPositionals(args).length > 0)
    throw new Error("--sync-all does not accept a skill name.")
  if (args.includes("--from")) throw new Error("--sync-all resolves direction itself; drop --from.")
  const agents = automaticSyncAgents(args, overwrite, "--sync-all")
  await syncAllSkills({ agents, dryRun, fileSystem })
}

async function handleSkillTransferArgs(
  args: string[],
  options?: SkillCommandOptions
): Promise<boolean> {
  validateProjectFlags(args)
  const sync = args.includes("--sync")
  const syncProject = args.includes("--sync-project")
  const syncGemini = args.includes("--sync-gemini")
  const syncAll = args.includes("--sync-all")
  const syncWatch = args.includes("--sync-watch")
  const convert = args.includes("--convert")
  const toCommand = args.includes("--to-command")
  const modes = [sync, syncProject, syncGemini, syncAll, syncWatch, convert, toCommand]
  if (!modes.some(Boolean)) return false
  validateTransferExclusivity(modes)
  const dryRun = args.includes("--dry-run")
  const overwrite = args.includes("--overwrite")
  if (syncProject) await handleSyncProject(args, options?.syncFileSystem)
  else if (convert) await handleConvert(args, dryRun, overwrite)
  else if (toCommand) await handleToCommand(args, dryRun, overwrite)
  else if (syncWatch) await handleSyncWatch(args, dryRun, overwrite, options)
  else if (syncAll) await handleSyncAll(args, dryRun, overwrite, options?.syncFileSystem)
  else await handleSync(args, syncGemini, dryRun, overwrite, options?.syncFileSystem)
  return true
}

function validateProjectFlags(args: string[]): void {
  if (!args.includes("--sync-project") && (args.includes("--project") || args.includes("--all"))) {
    throw new Error("--project and --all are only valid with --sync-project.")
  }
}

// ─── Command registration ───────────────────────────────────────────────────

export interface SkillCommandOptions {
  expandInlineCommands?: typeof expandInlineCommands
  syncFileSystem?: Partial<SkillSyncFileSystem>
  /** Test seams for --sync-watch; users always get the 20s quiet window and SIGTERM/SIGINT stop. */
  watchQuietMs?: number
  watchSweepMs?: number
  watchSignal?: AbortSignal
  /** Test seam for --sync-watch --install/--uninstall (home, launchctl runtime, paths). */
  launchAgent?: SkillSyncAgentOptions
}

export const skillCommand: Command<SkillCommandOptions> = {
  name: "skill",
  description: "Read, list, sync, and convert skills",
  usage:
    "swiz skill [--raw] [--no-front-matter] [skill-name] | --sync-project --from <agent> [--to <agent>] [--project <path>] [skill-name|--all] [--dry-run] [--overwrite] | --sync --from <agent> [--to <agent>] [--dry-run] [--overwrite] | --sync-gemini [--dry-run] [--overwrite] | --sync-all [--agents <hub,agent,...>] [--dry-run] | --sync-watch [--agents <hub,agent,...>] [--dry-run] [--install|--uninstall] | --sync-watch --from <agent> [--to <agent>] [--dry-run] [--overwrite] | --convert --from <agent> --to <agent> [skill-name] [--dry-run] [--overwrite] | --to-command --from <agent> [skill-name] [--dry-run] [--overwrite]",
  options: [
    { flags: "<skill-name>", description: "Print the skill content (omit to list all skills)" },
    { flags: "--raw", description: "Skip inline command expansion (!`cmd` substitutions)" },
    { flags: "--no-front-matter", description: "Strip YAML frontmatter from output" },
    {
      flags: "--sync",
      description:
        "Copy skills from --from <agent> to --to <agent> (default: claude). New skills are copied with their markdown converted into the target agent's tool names; existing targets are resolved per file from tool-name conversion, git history, and modification times — converted copies and newer targets are kept, stale targets are updated, divergent edits are three-way merged, and only unresolved conflicts are skipped",
    },
    {
      flags: "--sync-project",
      description:
        "Sync user skills into a project: requires --from <agent>; --to defaults to the same agent. Refreshes only skills already in the project, preserving project-only skills. Pass a skill name to import one, or --all to import every user skill. Uses the same conversion and conflict resolution as --sync",
    },
    {
      flags: "--project <path>",
      description:
        "Project directory for --sync-project (default: current Git worktree root). Targets <project>/.<agent>/skills; agents uses .agents/skills and antigravity uses .gemini/skills",
    },
    {
      flags: "--all",
      description: "With --sync-project: include user skills not yet installed in the project",
    },
    {
      flags: "--sync-gemini",
      description:
        "Alias for --sync --from gemini --to claude (copy ~/.gemini/skills into ~/.claude/skills)",
    },
    {
      flags: "--sync-all",
      description:
        "Two-way sync across agent skill roots in one pass: the hub (claude) is reconciled with every other root, each file's direction resolved like --sync, so edits made in any root reach all the others. Skills missing from a root are copied in that agent's tool names",
    },
    {
      flags: "--sync-watch",
      description:
        "Keep running and sync as skills change: two-way across --agents like --sync-all, or one-way with --from <agent> [--to <agent>]. A skill syncs only after 20s with no changes in any root, so edits in progress are never copied half-written; runs until SIGTERM or Ctrl+C",
    },
    {
      flags: "--install / --uninstall",
      description:
        "With --sync-watch: install (or remove) a login LaunchAgent (com.swiz.skill-sync) that runs the watch with the given arguments, restarts it if it exits, and logs to ~/Library/Logs/Swiz/skill-sync.log. --dry-run previews the change",
    },
    {
      flags: "--agents <hub,agent,...>",
      description:
        "Roots for --sync-all/--sync-watch, hub first (default: claude plus every other agent whose skills directory exists; agents sharing a directory are synced once). `agents` adds ~/.agents/skills",
    },
    {
      flags: "--convert",
      description:
        "Convert skills between agents, remapping tool names to target equivalents (optionally a single [skill-name])",
    },
    {
      flags: "--to-command",
      description: "Transform skills from --from <agent> to command files",
    },
    {
      flags: "--from <agent>",
      description:
        "Source agent ID (claude|cursor|gemini|codex|antigravity|agents). For agents, --sync reads project/user shared roots; --sync-project reads only ~/.agents/skills plus the legacy ~/.agents fallback.",
    },
    {
      flags: "--to <agent>",
      description:
        "Target agent ID (claude|cursor|gemini|codex|antigravity|agents). --sync-project writes to project skill directories; other sync modes write to user skill directories.",
    },
    {
      flags: "--dry-run",
      description:
        "Preview actions without writing files (--sync also lists paths it would add, update, or remove)",
    },
    {
      flags: "--overwrite",
      description:
        "Allow overwriting existing target skills or commands (--sync replaces the whole of any skill with an unresolved conflict — target-only files included — with the source, converting markdown into the target's tool names; identical, converted, and newer targets are never replaced. Preview with --dry-run)",
    },
  ],
  async run(args, options) {
    const handled = await handleSkillTransferArgs(args, options)
    if (handled) return

    if (args.includes("--install") || args.includes("--uninstall")) {
      throw new Error("--install and --uninstall are only valid with --sync-watch.")
    }

    if (args.includes("--dry-run") || args.includes("--overwrite")) {
      throw new Error(
        "--dry-run and --overwrite are only valid with --sync, --sync-project, --sync-gemini, --sync-all, --sync-watch, --convert, or --to-command."
      )
    }

    const raw = args.includes("--raw")
    const noFrontMatter = args.includes("--no-front-matter")
    const flags = new Set(["--raw", "--no-front-matter"])
    const positionals = args.filter((a) => !flags.has(a))
    const name = positionals[0]
    if (!name) {
      await listSkills()
    } else {
      await readSkill(name, raw, noFrontMatter, positionals.slice(1), options?.expandInlineCommands)
    }
  },
}
