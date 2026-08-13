import { existsSync } from "node:fs"
import { cp, mkdir, mkdtemp, readdir, rename, rm, stat } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { orderBy } from "lodash-es"
import { AGENTS, type AgentDef, getAgent } from "../agents.ts"
import { detectCurrentAgent } from "../detect.ts"
import { getHomeDir } from "../home.ts"
import { getProviderAdapter } from "../provider-adapters.ts"
import {
  buildSkillAgentToolEnvironmentFooter,
  extractMandatedSkillTools,
  extractReferencedToolsFromSkillText,
  findSkills,
  getAgentsSkillDir,
  getAgentsSkillDirs,
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

/** Positional (non-flag) args, excluding values consumed by --from/--to. */
function extractPositionals(args: string[]): string[] {
  const flagsWithValue = new Set(["--from", "--to"])
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
    if (await Bun.file(join(skillsDir, entry.name, "SKILL.md")).exists()) names.push(entry.name)
  }
  return orderBy(names, [(n) => n], ["asc"])
}

async function discoverSkillSources(
  skillsDirs: string[]
): Promise<{ name: string; sourceDir: string }[]> {
  const byName = new Map<string, string>()
  for (const sourceDir of skillsDirs) {
    for (const name of await discoverSkillNames(sourceDir)) {
      if (!byName.has(name)) byName.set(name, sourceDir)
    }
  }
  return orderBy(
    [...byName].map(([name, sourceDir]) => ({ name, sourceDir })),
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

function printSyncSummary(
  copied: number,
  overwritten: number,
  skipped: number,
  overwrite: boolean
): void {
  console.log(
    `\nSummary: ${copied} copied, ${overwritten} overwritten, ${skipped} skipped` +
      (!overwrite && skipped > 0 ? " (use --overwrite to replace existing targets)" : "")
  )
}

export interface SkillSyncFileSystem {
  copyDirectory(sourceDir: string, targetDir: string): Promise<void>
  createTemporaryDirectory(prefix: string): Promise<string>
  isFile(path: string): Promise<boolean>
  moveDirectory(sourceDir: string, targetDir: string): Promise<void>
  removeDirectory(path: string): Promise<void>
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
  sourceDir: string,
  targetDir: string,
  fileSystemOverrides: Partial<SkillSyncFileSystem> = {}
): Promise<void> {
  const fileSystem = resolveSkillSyncFileSystem(fileSystemOverrides)
  const targetParent = dirname(targetDir)
  const targetName = basename(targetDir)
  const stagingRoot = await fileSystem.createTemporaryDirectory(
    join(targetParent, `.${targetName}.sync-`)
  )
  const replacementDir = join(stagingRoot, "replacement")
  let backupRoot: string | null = null
  let preserveBackup = false

  try {
    await fileSystem.copyDirectory(sourceDir, replacementDir)
    if (!(await fileSystem.isFile(join(replacementDir, "SKILL.md")))) {
      throw new Error(`Copied skill ${targetName} is missing a valid SKILL.md.`)
    }

    if (!existsSync(targetDir)) {
      await fileSystem.moveDirectory(replacementDir, targetDir)
      return
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

type SkillTreeEntryKind = "directory" | "file" | "symlink"

async function collectSkillTreeEntries(
  rootDir: string,
  relativeDir = "",
  entries = new Map<string, SkillTreeEntryKind>()
): Promise<Map<string, SkillTreeEntryKind>> {
  const children = await readdir(join(rootDir, relativeDir), { withFileTypes: true })
  for (const child of children) {
    const relativePath = relativeDir ? join(relativeDir, child.name) : child.name
    const kind: SkillTreeEntryKind = child.isDirectory()
      ? "directory"
      : child.isSymbolicLink()
        ? "symlink"
        : "file"
    entries.set(relativePath, kind)
    if (kind === "directory") {
      await collectSkillTreeEntries(rootDir, relativePath, entries)
    }
  }
  return entries
}

async function findTargetOnlySkillPaths(sourceDir: string, targetDir: string): Promise<string[]> {
  const [sourceEntries, targetEntries] = await Promise.all([
    collectSkillTreeEntries(sourceDir),
    collectSkillTreeEntries(targetDir),
  ])
  const stalePaths: string[] = []
  for (const [path, kind] of targetEntries) {
    if (sourceEntries.get(path) === kind) continue
    stalePaths.push(kind === "directory" ? `${path}/` : path)
  }
  return stalePaths.sort()
}

type SkillSyncAction = "copied" | "overwritten" | "skipped"

async function syncSingleSkill(options: {
  name: string
  sourceDir: string
  targetRoot: string
  dryRun: boolean
  overwrite: boolean
  fileSystem?: Partial<SkillSyncFileSystem>
}): Promise<SkillSyncAction> {
  const { name, sourceDir, targetRoot, dryRun, overwrite, fileSystem } = options
  const sourceSkillDir = join(sourceDir, name)
  const targetDir = join(targetRoot, name)
  const targetExists = existsSync(targetDir)

  if (targetExists && !overwrite) {
    console.log(`  - skipped ${name} (already exists)`)
    return "skipped"
  }

  if (dryRun) {
    const action = logSkillAction(name, targetExists, true, "copied", "copy")
    if (targetExists) {
      for (const stalePath of await findTargetOnlySkillPaths(sourceSkillDir, targetDir)) {
        console.log(`    - would remove ${name}/${stalePath}`)
      }
    }
    return action === "overwrite" ? "overwritten" : "copied"
  }

  await replaceSkillDirectory(sourceSkillDir, targetDir, fileSystem)
  return logSkillAction(name, targetExists, false, "copied", "copy") === "overwrite"
    ? "overwritten"
    : "copied"
}

// Copy-only sync (no tool name remapping). Used by --sync --from <agent> and --sync-gemini alias.
async function syncSkills(options: {
  from: string
  to: string
  dryRun: boolean
  overwrite: boolean
  fileSystem?: Partial<SkillSyncFileSystem>
}): Promise<void> {
  const { from, to, dryRun, overwrite, fileSystem } = options
  const fromAgent = resolveForSync(from)
  const toAgent = resolveForSync(to)
  const fromSkillsDirs = sourceSkillDirs(from)
  const toSkillsDir = primarySkillDir(to)
  const orderedSkills = await discoverSkillSources(fromSkillsDirs)

  if (orderedSkills.length === 0) {
    console.log(
      `No ${fromAgent.name} skills with SKILL.md found at ${fromSkillsDirs.map(displayPath).join(", ")}.`
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

  let copied = 0,
    overwritten = 0,
    skipped = 0

  for (const { name, sourceDir } of orderedSkills) {
    const action = await syncSingleSkill({
      name,
      sourceDir,
      targetRoot: toSkillsDir,
      dryRun,
      overwrite,
      fileSystem,
    })
    if (action === "skipped") skipped++
    else if (action === "overwritten") overwritten++
    else copied++
  }

  printSyncSummary(copied, overwritten, skipped, overwrite)
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

function validateTransferExclusivity(
  sync: boolean,
  syncGemini: boolean,
  convert: boolean,
  toCommand: boolean
): void {
  const flags = [sync, syncGemini, convert, toCommand].filter(Boolean).length
  if (flags > 1) {
    throw new Error("--sync, --sync-gemini, --convert, and --to-command are mutually exclusive.")
  }
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

async function handleSkillTransferArgs(
  args: string[],
  fileSystem?: Partial<SkillSyncFileSystem>
): Promise<boolean> {
  const sync = args.includes("--sync")
  const syncGemini = args.includes("--sync-gemini")
  const convert = args.includes("--convert")
  const toCommand = args.includes("--to-command")
  if (!sync && !syncGemini && !convert && !toCommand) return false
  validateTransferExclusivity(sync, syncGemini, convert, toCommand)
  const dryRun = args.includes("--dry-run")
  const overwrite = args.includes("--overwrite")
  if (convert) await handleConvert(args, dryRun, overwrite)
  else if (toCommand) await handleToCommand(args, dryRun, overwrite)
  else await handleSync(args, syncGemini, dryRun, overwrite, fileSystem)
  return true
}

// ─── Command registration ───────────────────────────────────────────────────

export interface SkillCommandOptions {
  expandInlineCommands?: typeof expandInlineCommands
  syncFileSystem?: Partial<SkillSyncFileSystem>
}

export const skillCommand: Command<SkillCommandOptions> = {
  name: "skill",
  description: "Read, list, sync, and convert skills",
  usage:
    "swiz skill [--raw] [--no-front-matter] [skill-name] | --sync --from <agent> [--to <agent>] [--dry-run] [--overwrite] | --sync-gemini [--dry-run] [--overwrite] | --convert --from <agent> --to <agent> [skill-name] [--dry-run] [--overwrite] | --to-command --from <agent> [skill-name] [--dry-run] [--overwrite]",
  options: [
    { flags: "<skill-name>", description: "Print the skill content (omit to list all skills)" },
    { flags: "--raw", description: "Skip inline command expansion (!`cmd` substitutions)" },
    { flags: "--no-front-matter", description: "Strip YAML frontmatter from output" },
    {
      flags: "--sync",
      description:
        "Copy skills from --from <agent> to --to <agent> (default: claude) (copy-only; use --convert for tool name remapping)",
    },
    {
      flags: "--sync-gemini",
      description:
        "Alias for --sync --from gemini --to claude (copy ~/.gemini/skills into ~/.claude/skills)",
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
        "Source agent ID (claude|cursor|gemini|codex|agents). The `agents` source is supported by --sync only and reads repository/user .agents/skills roots plus the legacy ~/.agents fallback.",
    },
    {
      flags: "--to <agent>",
      description:
        "Target agent ID (claude|cursor|gemini|codex|agents). The `agents` target is supported by --sync only and writes to ~/.agents/skills/.",
    },
    { flags: "--dry-run", description: "Preview actions without writing files" },
    { flags: "--overwrite", description: "Allow overwriting existing target skills or commands" },
  ],
  async run(args, options) {
    const handled = await handleSkillTransferArgs(args, options?.syncFileSystem)
    if (handled) return

    if (args.includes("--dry-run") || args.includes("--overwrite")) {
      throw new Error(
        "--dry-run and --overwrite are only valid with --sync, --sync-gemini, --convert, or --to-command."
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
