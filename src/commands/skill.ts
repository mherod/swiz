import { existsSync } from "node:fs"
import { cp, mkdir, readdir } from "node:fs/promises"
import { join } from "node:path"
import { orderBy } from "lodash-es"
import { AGENTS, getAgent } from "../agents.ts"
import { getHomeDir } from "../home.ts"
import { getProviderAdapter } from "../provider-adapters.ts"
import {
  extractMandatedSkillTools,
  findSkills,
  getSkillToolAvailabilityWarning,
  parseFrontmatterField,
  stripFrontmatter,
} from "../skill-utils.ts"
import type { Command } from "../types.ts"
import {
  eliminatePositionalArgs,
  expandInlineCommands,
  substituteArgs,
  unwrapInlineCommands,
} from "../utils/skill-content.ts"
import { convertSkillContent } from "../utils/skill-conversion.ts"

export { parseFrontmatterField, stripFrontmatter }

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

// ─── Single-skill conversion (reads file, converts, writes) ──────────────────

async function convertSingleSkill(opts: {
  fromSkillsDir: string
  name: string
  targetDir: string
  from: string
  to: string
  dryRun: boolean
}): Promise<{ unmapped: string[]; warnSuffix: string }> {
  const original = await Bun.file(join(opts.fromSkillsDir, opts.name, "SKILL.md")).text()
  const { content, unmapped } = convertSkillContent(
    original,
    getAgent(opts.from)!,
    getAgent(opts.to)!,
    AGENTS
  )
  const warnSuffix = unmapped.length > 0 ? ` [⚠ unmapped: ${unmapped.join(", ")}]` : ""
  if (!opts.dryRun) {
    await mkdir(opts.targetDir, { recursive: true })
    await Bun.write(join(opts.targetDir, "SKILL.md"), content)
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
    if (!entry.isDirectory()) continue
    if (await Bun.file(join(skillsDir, entry.name, "SKILL.md")).exists()) names.push(entry.name)
  }
  return orderBy(names, [(n) => n], ["asc"])
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

// ─── Flag parsing and routing ───────────────────────────────────────────────

async function exportCommand(options: {
  from: string
  to: string
  dryRun: boolean
  overwrite: boolean
  name?: string
}): Promise<void> {
  const { from, to, dryRun, overwrite, name } = options
  const { fromAgent, toAgent } = resolveAgentPair(from, to)

  if (toAgent.id !== "junie") {
    throw new Error(`Command export is currently only supported for the 'junie' agent.`)
  }

  const fromSkillsDir = primarySkillDir(from)
  const commandsDir = join(HOME, `.${toAgent.id}`, "commands")
  const orderedSkillNames = name ? [name] : await discoverSkillNames(fromSkillsDir)

  if (orderedSkillNames.length === 0) {
    console.log(`No ${fromAgent.name} skills found at ${displayPath(fromSkillsDir)}.`)
    return
  }

  console.log(
    dryRun
      ? `Dry run: exporting ${fromAgent.name} skills to ${toAgent.name} commands (no files will be written).`
      : `Exporting ${fromAgent.name} skills to ${toAgent.name} commands.`
  )
  if (!dryRun) await mkdir(commandsDir, { recursive: true })

  let exported = 0,
    overwritten = 0,
    skipped = 0

  for (const skillName of orderedSkillNames) {
    const targetFile = join(commandsDir, `${skillName}.md`)
    const targetExists = existsSync(targetFile)

    if (targetExists && !overwrite) {
      skipped++
      console.log(`  - skipped ${skillName} (already exists)`)
      continue
    }

    try {
      const original = await Bun.file(join(fromSkillsDir, skillName, "SKILL.md")).text()
      const { content: convertedContent, unmapped } = convertSkillContent(
        original,
        fromAgent,
        toAgent,
        AGENTS
      )
      const description = parseFrontmatterField(original, "description") || ""
      let convertedBody = stripFrontmatter(convertedContent).trim()

      // Transform skill variables to default command values
      convertedBody = eliminatePositionalArgs(convertedBody)
      convertedBody = unwrapInlineCommands(convertedBody)

      const frontmatter = ["---", `name: ${skillName}`, `description: ${description}`]

      const allowedTools = extractMandatedSkillTools(convertedContent)
      if (allowedTools.length > 0) {
        frontmatter.push(`allowed-tools: ${allowedTools.join(", ")}`)
      }

      frontmatter.push("---")

      const commandContent = [...frontmatter, "", convertedBody, ""].join("\n")

      if (!dryRun) {
        await Bun.write(targetFile, commandContent)
      }

      const warnSuffix = unmapped.length > 0 ? ` [⚠ unmapped: ${unmapped.join(", ")}]` : ""
      if (
        logSkillAction(
          `${skillName}.md${warnSuffix}`,
          targetExists,
          dryRun,
          "exported",
          "export"
        ) === "overwrite"
      ) {
        overwritten++
      } else {
        exported++
      }
    } catch (e) {
      console.log(
        `  - failed to export ${skillName}: ${e instanceof Error ? e.message : String(e)}`
      )
    }
  }

  console.log(
    `\nSummary: ${exported} exported, ${overwritten} overwritten, ${skipped} skipped` +
      (!overwrite && skipped > 0 ? " (use --overwrite to replace existing targets)" : "")
  )
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
  await convertSkills({ from, to, dryRun, overwrite })
}

async function handleToCommand(args: string[], dryRun: boolean, overwrite: boolean): Promise<void> {
  const from = extractFlagValue(args, "--from")
  if (!from) throw new Error("--to-command requires --from <agent>.")
  // Target agent is always junie for commands
  const to = "junie"

  const flagsWithValue = new Set(["--from", "--to"])
  const positionals = args.filter(
    (a, i) => !a.startsWith("--") && !flagsWithValue.has(args[i - 1] ?? "")
  )
  // The first positional after removing flags is considered the specific skill name
  const name = positionals[0]

  await exportCommand({ from, to, dryRun, overwrite, name })
}

async function handleSync(
  args: string[],
  syncGemini: boolean,
  dryRun: boolean,
  overwrite: boolean
): Promise<void> {
  const flagsWithValue = new Set(["--from", "--to"])
  const positionals = args.filter(
    (a, i) => !a.startsWith("--") && !flagsWithValue.has(args[i - 1] ?? "")
  )
  if (positionals.length > 0) throw new Error("--sync/--sync-gemini does not accept a skill name.")
  const from = syncGemini ? "gemini" : extractFlagValue(args, "--from")
  if (!from) throw new Error("--sync requires --from <agent>.")
  const to = extractFlagValue(args, "--to") ?? "claude"
  await syncSkills({ from, to, dryRun, overwrite })
}

async function handleSkillTransferArgs(args: string[]): Promise<boolean> {
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
  else await handleSync(args, syncGemini, dryRun, overwrite)
  return true
}

// ─── Command registration ───────────────────────────────────────────────────

export const skillCommand: Command = {
  name: "skill",
  description: "Read, list, sync, and convert skills",
  usage:
    "swiz skill [--raw] [--no-front-matter] [skill-name] | --sync --from <agent> [--to <agent>] [--dry-run] [--overwrite] | --sync-gemini [--dry-run] [--overwrite] | --convert --from <agent> --to <agent> [--dry-run] [--overwrite] | --to-command --from <agent> [skill-name] [--dry-run] [--overwrite]",
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
      description: "Convert skills between agents, remapping tool names to target equivalents",
    },
    {
      flags: "--to-command",
      description: "Transform skills from --from <agent> to Junie commands",
    },
    {
      flags: "--from <agent>",
      description:
        "Source agent ID for --sync, --convert, or --to-command (claude|cursor|gemini|codex|junie)",
    },
    {
      flags: "--to <agent>",
      description: "Target agent ID for --sync or --convert (claude|cursor|gemini|codex|junie)",
    },
    { flags: "--dry-run", description: "Preview actions without writing files" },
    { flags: "--overwrite", description: "Allow overwriting existing target skills or commands" },
  ],
  async run(args) {
    const handled = await handleSkillTransferArgs(args)
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
      await readSkill(name, raw, noFrontMatter, positionals.slice(1))
    }
  },
}
