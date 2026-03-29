import { existsSync } from "node:fs"
import { cp, mkdir, readdir } from "node:fs/promises"
import { join } from "node:path"
import { orderBy } from "lodash-es"
import { AGENTS, getAgent } from "../agents.ts"
import { getHomeDir } from "../home.ts"
import { getProviderAdapter } from "../provider-adapters.ts"
import {
  findSkills,
  getSkillToolAvailabilityWarning,
  parseFrontmatterField,
  stripFrontmatter,
} from "../skill-utils.ts"
import type { Command } from "../types.ts"
import { parseQuotedString, transformQuotedString } from "../utils/quoted-string.ts"

export { parseFrontmatterField, stripFrontmatter }

const INLINE_CMD_RE = /!`([^`]+)`/g
const HOME = getHomeDir()

function primarySkillDir(agentId: string): string {
  const adapter = getProviderAdapter(agentId)
  const primary = adapter?.getSkillDirs()[0]
  if (primary) return primary

  return join(HOME, `.${agentId}`, "skills")
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

export async function expandInlineCommands(content: string): Promise<string> {
  const matches = [...content.matchAll(INLINE_CMD_RE)]
  if (matches.length === 0) return content

  const results = await Promise.all(
    matches.map(async (m) => {
      const cmd = m[1]!
      try {
        const proc = Bun.spawn(["sh", "-c", cmd], {
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, PATH: process.env.PATH },
        })
        const [stdout] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ])
        await proc.exited
        return stdout.trim()
      } catch {
        return `[error running: ${cmd}]`
      }
    })
  )

  let i = 0
  return content.replace(INLINE_CMD_RE, () => results[i++]!)
}

export function substituteArgs(content: string, positionalArgs: string[]): string {
  if (positionalArgs.length === 0) return content
  let result = content
  // $ARGUMENTS → full space-joined remaining args
  result = result.replace(/\$ARGUMENTS\b/g, positionalArgs.join(" "))
  // $0, $1, … → individual positional args (empty string if out of range)
  for (let i = 0; i < positionalArgs.length; i++) {
    const escaped = positionalArgs[i]!.replace(/[$&`\\]/g, "\\$&")
    result = result.replace(new RegExp(`\\$${i}\\b`, "g"), escaped)
  }
  return result
}

async function readSkill(
  name: string,
  raw: boolean,
  noFrontMatter: boolean,
  positionalArgs: string[] = []
) {
  const skills = await findSkills()
  const skill = skills.find((s) => s.name === name)

  if (!skill) {
    throw new Error(`Skill not found: ${name}\nRun "swiz skill" to list available skills.`)
  }

  let content = await Bun.file(skill.path).text()
  const availabilityWarning = getSkillToolAvailabilityWarning(name, content)
  if (availabilityWarning) {
    console.log(availabilityWarning.message)
  }
  content = substituteArgs(content, positionalArgs)
  if (!raw) {
    content = await expandInlineCommands(content)
  }
  if (noFrontMatter) {
    content = stripFrontmatter(content)
  }
  console.log(content)
}

function displayPath(path: string): string {
  return path.startsWith(HOME) ? `~${path.slice(HOME.length)}` : path
}

// ─── Cross-agent skill conversion ────────────────────────────────────────────

export interface ConversionResult {
  content: string
  /** Tool names that exist in the source but have no mapping in the target */
  unmapped: string[]
}

/**
 * Build a reverse alias map: agent-specific tool name → canonical (Claude) name.
 * Claude's toolAliases is `{}`, so for Claude as source the reverse map is empty
 * (agent name == canonical name already).
 */
function buildReverseMap(toolAliases: Record<string, string>): Record<string, string> {
  const rev: Record<string, string> = {}
  for (const [canonical, agentSpecific] of Object.entries(toolAliases)) {
    rev[agentSpecific] = canonical
  }
  return rev
}

/**
 * Rewrite a comma-separated list of tool names (as found in frontmatter
 * `allowed-tools` fields) using the provided remapping function.
 */
function remapToolList(
  list: string,
  remap: (tool: string) => string
): { result: string; unmapped: string[] } {
  function remapToken(raw: string): { token: string; unmapped?: string } {
    const { result, unmapped } = transformQuotedString(raw, remap)
    return {
      token: result,
      unmapped,
    }
  }

  const unmapped: string[] = []
  const result = list
    .split(",")
    .map((raw) => {
      if (!raw.trim()) return raw
      const { token, unmapped: u } = remapToken(raw)
      if (u) unmapped.push(u)
      return token
    })
    .join(", ")
  return { result, unmapped }
}

function remapPossiblyQuotedTool(
  raw: string,
  remap: (tool: string) => string
): { mappedRaw: string; unmapped?: string } {
  const { quoteChar, content } = parseQuotedString(raw)
  const mapped = remap(content)
  return {
    mappedRaw: quoteChar ? `${quoteChar}${mapped}${quoteChar}` : mapped,
    unmapped: mapped === content ? content : undefined,
  }
}

function remapAllowedToolsBlock(
  frontmatterLines: string[],
  startIndex: number,
  remap: (tool: string) => string
): { lines: string[]; nextIndex: number; unmapped: string[] } {
  const lines: string[] = []
  const unmapped: string[] = []
  let index = startIndex

  while (index < frontmatterLines.length) {
    const listLine = frontmatterLines[index]!
    const itemMatch = listLine.match(/^(\s*-\s*)(.+)$/)
    if (!itemMatch) break

    const { mappedRaw, unmapped: unmatchedTool } = remapPossiblyQuotedTool(itemMatch[2]!, remap)
    if (unmatchedTool) unmapped.push(unmatchedTool)
    lines.push(`${itemMatch[1]}${mappedRaw}`)
    index++
  }

  return { lines, nextIndex: index, unmapped }
}

function remapAllowedToolsFrontmatter(
  content: string,
  remap: (tool: string) => string
): { result: string; unmapped: string[] } {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---([ \t]*\n?)/)
  if (!frontmatterMatch) return { result: content, unmapped: [] }

  const fullMatch = frontmatterMatch[0]
  const frontmatterBody = frontmatterMatch[1] ?? ""
  const frontmatterLines = frontmatterBody.split("\n")
  const unmapped: string[] = []

  const remappedLines: string[] = []
  for (let i = 0; i < frontmatterLines.length; i++) {
    const line = frontmatterLines[i]!
    const inlineMatch = line.match(/^(allowed-tools\s*:\s*)(.+)$/)
    if (inlineMatch) {
      const { result: remapped, unmapped: inlineUnmapped } = remapToolList(inlineMatch[2]!, remap)
      for (const u of inlineUnmapped) unmapped.push(u)
      remappedLines.push(`${inlineMatch[1]}${remapped}`)
      continue
    }

    const blockMatch = line.match(/^(allowed-tools\s*:\s*)$/)
    if (!blockMatch) {
      remappedLines.push(line)
      continue
    }

    remappedLines.push(line)
    const blockResult = remapAllowedToolsBlock(frontmatterLines, i + 1, remap)
    remappedLines.push(...blockResult.lines)
    unmapped.push(...blockResult.unmapped)
    i = blockResult.nextIndex - 1
  }

  const remappedFrontmatter = `---\n${remappedLines.join("\n")}\n---${frontmatterMatch[2] ?? ""}`
  return {
    result: content.replace(fullMatch, remappedFrontmatter),
    unmapped,
  }
}

/**
 * Convert a SKILL.md content string from one agent's tool names to another's.
 *
 * Strategy:
 *  1. Build a reverse map from source agent's toolAliases (agent-specific → canonical).
 *  2. Compose with target agent's toolAliases (canonical → agent-specific).
 *  3. Apply to frontmatter `allowed-tools` inline list.
 *  4. Apply whole-word replacement in the body text.
 *
 * Unmapped tool names (source-specific with no target equivalent) are collected
 * and returned without modification — no silent data loss.
 */
function collectSourceToolNames(
  fromAgent: (typeof AGENTS)[number],
  supplement: Record<string, string>
): Set<string> {
  const names = new Set<string>([
    ...Object.keys(fromAgent.toolAliases),
    ...Object.values(fromAgent.toolAliases),
  ])
  for (const agent of AGENTS) {
    for (const canonical of Object.keys(agent.toolAliases)) names.add(canonical)
  }
  for (const canonical of Object.keys(supplement)) names.add(canonical)
  return names
}

function rewriteBodyToolNames(
  text: string,
  fromAgent: (typeof AGENTS)[number],
  supplement: Record<string, string>,
  remap: (tool: string) => string
): string {
  let result = text
  for (const sourceName of collectSourceToolNames(fromAgent, supplement)) {
    const mapped = remap(sourceName)
    if (mapped === sourceName) continue
    const escaped = sourceName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    result = result.replace(new RegExp(`\\b${escaped}\\b`, "g"), mapped)
  }
  return result
}

export function convertSkillContent(
  content: string,
  fromAgentId: string,
  toAgentId: string
): ConversionResult {
  if (fromAgentId === toAgentId) return { content, unmapped: [] }

  const fromAgent = getAgent(fromAgentId)
  const toAgent = getAgent(toAgentId)
  if (!fromAgent || !toAgent) return { content, unmapped: [] }

  const reverseFrom = buildReverseMap(fromAgent.toolAliases)
  const toAliases = toAgent.toolAliases

  // Conversion-only supplement: read-only task tools (TaskList, TaskGet) are intentionally
  // absent from toolAliases (they must pass through in hook contexts) but should be remapped
  // during skill conversion to the same target as TaskCreate, if one exists.
  const taskCreateTarget = toAliases.TaskCreate
  const conversionSupplement: Record<string, string> = taskCreateTarget
    ? { TaskList: taskCreateTarget, TaskGet: taskCreateTarget }
    : {}

  /** Resolve a single tool token: source-specific → canonical → target-specific */
  function remap(tool: string): string {
    const canonical = reverseFrom[tool] ?? tool // source → canonical
    return toAliases[canonical] ?? conversionSupplement[canonical] ?? canonical // canonical → target
  }

  const unmappedSet = new Set<string>()

  // ── Rewrite frontmatter allowed-tools field ──────────────────────────────
  // Supports both inline and YAML-list forms.
  const remappedFrontmatter = remapAllowedToolsFrontmatter(content, remap)
  for (const u of remappedFrontmatter.unmapped) unmappedSet.add(u)
  let result = remappedFrontmatter.result

  result = rewriteBodyToolNames(result, fromAgent, conversionSupplement, remap)
  return { content: result, unmapped: [...unmappedSet] }
}

type AgentEntry = (typeof AGENTS)[number]

function resolveAgentPair(
  from: string,
  to: string
): { fromAgent: AgentEntry; toAgent: AgentEntry } {
  const fromAgent = getAgent(from)
  const toAgent = getAgent(to)
  const ids = AGENTS.map((a) => a.id).join(", ")
  if (!fromAgent) throw new Error(`Unknown agent: ${from}. Valid agent IDs: ${ids}`)
  if (!toAgent) throw new Error(`Unknown agent: ${to}. Valid agent IDs: ${ids}`)
  return { fromAgent, toAgent }
}

async function discoverSkillNames(skillsDir: string): Promise<string[]> {
  let entries: import("node:fs").Dirent[]
  try {
    entries = await readdir(skillsDir, { withFileTypes: true })
  } catch {
    return []
  }
  const names: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (await Bun.file(join(skillsDir, entry.name, "SKILL.md")).exists()) names.push(entry.name)
  }
  return orderBy(names, [(n) => n], ["asc"])
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
  const { content, unmapped } = convertSkillContent(original, opts.from, opts.to)
  const warnSuffix = unmapped.length > 0 ? ` [⚠ unmapped: ${unmapped.join(", ")}]` : ""
  if (!opts.dryRun) {
    await mkdir(opts.targetDir, { recursive: true })
    await Bun.write(join(opts.targetDir, "SKILL.md"), content)
  }
  return { unmapped, warnSuffix }
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
  if (allUnmapped.size > 0) {
    console.log(
      `⚠ Unmapped tool names (no equivalent in ${agentName}): ${[...allUnmapped].join(", ")}`
    )
    console.log("  These tool names were preserved as-is. Review and update manually if needed.")
  }
}

/** Convert all skills from one agent to another. */
async function convertSkills(options: {
  from: string
  to: string
  dryRun: boolean
  overwrite: boolean
}): Promise<void> {
  const { from, to, dryRun, overwrite } = options
  const { fromAgent, toAgent } = resolveAgentPair(from, to)
  const fromSkillsDir = primarySkillDir(from)
  const toSkillsDir = primarySkillDir(to)
  const orderedSkillNames = await discoverSkillNames(fromSkillsDir)

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

// Copy-only sync (no tool name remapping). Used by --sync --from <agent> and --sync-gemini alias.
async function syncSkills(options: {
  from: string
  to: string
  dryRun: boolean
  overwrite: boolean
}): Promise<void> {
  const { from, to, dryRun, overwrite } = options
  const { fromAgent, toAgent } = resolveAgentPair(from, to)
  const fromSkillsDir = primarySkillDir(from)
  const toSkillsDir = primarySkillDir(to)
  const orderedSkillNames = await discoverSkillNames(fromSkillsDir)

  if (orderedSkillNames.length === 0) {
    console.log(`No ${fromAgent.name} skills with SKILL.md found at ${displayPath(fromSkillsDir)}.`)
    return
  }

  console.log(
    dryRun
      ? `Dry run: syncing ${fromAgent.name} → ${toAgent.name} skills (no files will be changed).`
      : `Syncing ${fromAgent.name} → ${toAgent.name} skills.`
  )
  if (!dryRun) await mkdir(toSkillsDir, { recursive: true })
  console.log(`Source: ${displayPath(fromSkillsDir)}`)
  console.log(`Target: ${displayPath(toSkillsDir)}\n`)

  let copied = 0,
    overwritten = 0,
    skipped = 0

  for (const name of orderedSkillNames) {
    const targetDir = join(toSkillsDir, name)
    const targetExists = existsSync(targetDir)
    if (targetExists && !overwrite) {
      skipped++
      console.log(`  - skipped ${name} (already exists)`)
      continue
    }
    if (!dryRun)
      await cp(join(fromSkillsDir, name), targetDir, { recursive: true, force: overwrite })
    if (logSkillAction(name, targetExists, dryRun, "copied", "copy") === "overwrite") overwritten++
    else copied++
  }

  printSyncSummary(copied, overwritten, skipped, overwrite)
}

function extractFlagValue(args: string[], flag: string): string | null {
  const idx = args.indexOf(flag)
  return idx >= 0 ? (args[idx + 1] ?? null) : null
}

function validateTransferExclusivity(sync: boolean, syncGemini: boolean, convert: boolean): void {
  if ((sync || syncGemini) && convert)
    throw new Error("--sync/--sync-gemini and --convert are mutually exclusive.")
  if (sync && syncGemini) throw new Error("--sync and --sync-gemini are mutually exclusive.")
}

async function handleConvert(args: string[], dryRun: boolean, overwrite: boolean): Promise<void> {
  const from = extractFlagValue(args, "--from")
  const to = extractFlagValue(args, "--to")
  if (!from) throw new Error("--convert requires --from <agent>.")
  if (!to) throw new Error("--convert requires --to <agent>.")
  await convertSkills({ from, to, dryRun, overwrite })
}

async function handleSync(
  args: string[],
  syncGemini: boolean,
  dryRun: boolean,
  overwrite: boolean
): Promise<void> {
  const positional = args.filter((a) => !a.startsWith("--"))
  if (positional.length > 0) throw new Error("--sync/--sync-gemini does not accept a skill name.")
  const from = syncGemini ? "gemini" : extractFlagValue(args, "--from")
  if (!from) throw new Error("--sync requires --from <agent>.")
  await syncSkills({ from, to: "claude", dryRun, overwrite })
}

async function handleSkillTransferArgs(args: string[]): Promise<boolean> {
  const sync = args.includes("--sync")
  const syncGemini = args.includes("--sync-gemini")
  const convert = args.includes("--convert")
  if (!sync && !syncGemini && !convert) return false
  validateTransferExclusivity(sync, syncGemini, convert)
  const dryRun = args.includes("--dry-run")
  const overwrite = args.includes("--overwrite")
  if (convert) await handleConvert(args, dryRun, overwrite)
  else await handleSync(args, syncGemini, dryRun, overwrite)
  return true
}

export const skillCommand: Command = {
  name: "skill",
  description: "Read, list, sync, and convert skills",
  usage:
    "swiz skill [--raw] [--no-front-matter] [skill-name] | --sync --from <agent> [--dry-run] [--overwrite] | --sync-gemini [--dry-run] [--overwrite] | --convert --from <agent> --to <agent> [--dry-run] [--overwrite]",
  options: [
    { flags: "<skill-name>", description: "Print the skill content (omit to list all skills)" },
    { flags: "--raw", description: "Skip inline command expansion (!`cmd` substitutions)" },
    { flags: "--no-front-matter", description: "Strip YAML frontmatter from output" },
    {
      flags: "--sync",
      description:
        "Copy skills from --from <agent> into ~/.claude/skills (copy-only; use --convert for tool name remapping)",
    },
    {
      flags: "--sync-gemini",
      description: "Alias for --sync --from gemini (copy ~/.gemini/skills into ~/.claude/skills)",
    },
    {
      flags: "--convert",
      description: "Convert skills between agents, remapping tool names to target equivalents",
    },
    {
      flags: "--from <agent>",
      description: "Source agent ID for --sync or --convert (claude|cursor|gemini|codex)",
    },
    {
      flags: "--to <agent>",
      description: "Target agent ID for --convert (claude|cursor|gemini|codex)",
    },
    { flags: "--dry-run", description: "Preview actions without writing files" },
    { flags: "--overwrite", description: "Allow overwriting existing target skills" },
  ],
  async run(args) {
    const handled = await handleSkillTransferArgs(args)
    if (handled) return

    if (args.includes("--dry-run") || args.includes("--overwrite")) {
      throw new Error(
        "--dry-run and --overwrite are only valid with --sync, --sync-gemini, or --convert."
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
      await readSkill(name, raw, noFrontMatter, positionals.slice(1))
    }
  },
}
