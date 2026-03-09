import { existsSync } from "node:fs"
import { cp, mkdir, readdir } from "node:fs/promises"
import { join } from "node:path"
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

async function expandInlineCommands(content: string): Promise<string> {
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

async function readSkill(name: string, raw: boolean, noFrontMatter: boolean) {
  const skills = await findSkills()
  const skill = skills.find((s) => s.name === name)

  if (!skill) {
    throw new Error(`Skill not found: ${name}\nRun "swiz skill" to list available skills.`)
  }

  let content = await Bun.file(skill.path).text()
  const availabilityWarning = getSkillToolAvailabilityWarning(name, content)
  if (availabilityWarning) {
    console.error(availabilityWarning.message)
  }
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
    const trimmed = raw.trim()
    const quoted =
      (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))
    const quoteChar = quoted ? trimmed[0] : ""
    const unquoted = quoted ? trimmed.slice(1, -1) : trimmed
    const mapped = remap(unquoted)
    return {
      token: quoteChar ? `${quoteChar}${mapped}${quoteChar}` : mapped,
      unmapped: mapped === unquoted ? unquoted : undefined,
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
    let j = i + 1
    while (j < frontmatterLines.length) {
      const listLine = frontmatterLines[j]!
      const itemMatch = listLine.match(/^(\s*-\s*)(.+)$/)
      if (!itemMatch) break

      const raw = itemMatch[2]!.trim()
      const quoted =
        (raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))
      const quoteChar = quoted ? raw[0] : ""
      const unquoted = quoted ? raw.slice(1, -1) : raw
      const mapped = remap(unquoted)
      if (mapped === unquoted) unmapped.push(unquoted)
      const mappedRaw = quoteChar ? `${quoteChar}${mapped}${quoteChar}` : mapped
      remappedLines.push(`${itemMatch[1]}${mappedRaw}`)
      j++
    }

    i = j - 1
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

  // ── Rewrite whole-word tool name references in the body ──────────────────
  // Collect all known source-agent names (canonical + agent-specific aliases)
  const sourceNames = new Set<string>([
    ...Object.keys(fromAgent.toolAliases), // canonical names (e.g. Bash, Edit)
    ...Object.values(fromAgent.toolAliases), // agent-specific (e.g. run_shell_command)
  ])
  // Also include canonical names that have no alias in fromAgent (they ARE canonical already)
  // Build from ALL agents' canonical keys to be comprehensive
  for (const agent of AGENTS) {
    for (const canonical of Object.keys(agent.toolAliases)) {
      sourceNames.add(canonical)
    }
  }
  // Ensure read-only task tools are always included — they may not appear in any alias table
  // but are valid canonical names used in skill bodies.
  for (const canonical of Object.keys(conversionSupplement)) {
    sourceNames.add(canonical)
  }

  for (const sourceName of sourceNames) {
    const mapped = remap(sourceName)
    if (mapped === sourceName) continue // no change needed
    // Whole-word replacement: \b boundaries
    const escaped = sourceName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    result = result.replace(new RegExp(`\\b${escaped}\\b`, "g"), mapped)
  }

  return { content: result, unmapped: [...unmappedSet] }
}

/** Convert all skills from one agent to another. */
async function convertSkills(options: {
  from: string
  to: string
  dryRun: boolean
  overwrite: boolean
}): Promise<void> {
  const { from, to, dryRun, overwrite } = options
  const fromAgent = getAgent(from)
  const toAgent = getAgent(to)

  if (!fromAgent) {
    const ids = AGENTS.map((a) => a.id).join(", ")
    throw new Error(`Unknown agent: ${from}. Valid agent IDs: ${ids}`)
  }
  if (!toAgent) {
    const ids = AGENTS.map((a) => a.id).join(", ")
    throw new Error(`Unknown agent: ${to}. Valid agent IDs: ${ids}`)
  }

  const fromSkillsDir = primarySkillDir(from)
  const toSkillsDir = primarySkillDir(to)

  let entries: import("node:fs").Dirent[]
  try {
    entries = await readdir(fromSkillsDir, { withFileTypes: true })
  } catch {
    console.log(`No ${fromAgent.name} skills found at ${displayPath(fromSkillsDir)}.`)
    return
  }

  const skillNames: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const sourceSkillPath = join(fromSkillsDir, entry.name, "SKILL.md")
    if (!(await Bun.file(sourceSkillPath).exists())) continue
    skillNames.push(entry.name)
  }
  skillNames.sort((a, b) => a.localeCompare(b))

  if (skillNames.length === 0) {
    console.log(`No ${fromAgent.name} skills with SKILL.md found at ${displayPath(fromSkillsDir)}.`)
    return
  }

  if (dryRun) {
    console.log(
      `Dry run: converting ${fromAgent.name} → ${toAgent.name} skills (no files will be written).`
    )
  } else {
    console.log(`Converting ${fromAgent.name} → ${toAgent.name} skills.`)
    await mkdir(toSkillsDir, { recursive: true })
  }
  console.log(`Source: ${displayPath(fromSkillsDir)}`)
  console.log(`Target: ${displayPath(toSkillsDir)}\n`)

  let converted = 0
  let overwritten = 0
  let skipped = 0
  const allUnmapped = new Set<string>()

  for (const name of skillNames) {
    const sourceSkillPath = join(fromSkillsDir, name, "SKILL.md")
    const targetDir = join(toSkillsDir, name)
    const targetSkillPath = join(targetDir, "SKILL.md")
    const targetExists = existsSync(targetDir)

    if (targetExists && !overwrite) {
      skipped++
      console.log(`  - skipped ${name} (already exists)`)
      continue
    }

    const original = await Bun.file(sourceSkillPath).text()
    const { content, unmapped } = convertSkillContent(original, from, to)
    for (const u of unmapped) allUnmapped.add(u)

    const warnSuffix = unmapped.length > 0 ? ` [⚠ unmapped: ${unmapped.join(", ")}]` : ""

    if (dryRun) {
      if (targetExists) {
        overwritten++
        console.log(`  - would overwrite ${name}${warnSuffix}`)
      } else {
        converted++
        console.log(`  - would convert ${name}${warnSuffix}`)
      }
      continue
    }

    await mkdir(targetDir, { recursive: true })
    await Bun.write(targetSkillPath, content)
    if (targetExists) {
      overwritten++
      console.log(`  - overwritten ${name}${warnSuffix}`)
    } else {
      converted++
      console.log(`  - converted ${name}${warnSuffix}`)
    }
  }

  console.log(
    `\nSummary: ${converted} converted, ${overwritten} overwritten, ${skipped} skipped` +
      (!overwrite && skipped > 0 ? " (use --overwrite to replace existing targets)" : "")
  )
  if (allUnmapped.size > 0) {
    console.log(
      `⚠ Unmapped tool names (no equivalent in ${toAgent.name}): ${[...allUnmapped].join(", ")}`
    )
    console.log("  These tool names were preserved as-is. Review and update manually if needed.")
  }
}

// Copy-only sync (no tool name remapping). Used by --sync --from <agent> and --sync-gemini alias.
async function syncSkills(options: {
  from: string
  to: string
  dryRun: boolean
  overwrite: boolean
}): Promise<void> {
  const { from, to, dryRun, overwrite } = options
  const fromAgent = getAgent(from)
  const toAgent = getAgent(to)

  if (!fromAgent) {
    const ids = AGENTS.map((a) => a.id).join(", ")
    throw new Error(`Unknown agent: ${from}. Valid agent IDs: ${ids}`)
  }
  if (!toAgent) {
    const ids = AGENTS.map((a) => a.id).join(", ")
    throw new Error(`Unknown agent: ${to}. Valid agent IDs: ${ids}`)
  }

  const fromSkillsDir = primarySkillDir(from)
  const toSkillsDir = primarySkillDir(to)

  let entries: import("node:fs").Dirent[]
  try {
    entries = await readdir(fromSkillsDir, { withFileTypes: true })
  } catch {
    console.log(`No ${fromAgent.name} skills found at ${displayPath(fromSkillsDir)}.`)
    return
  }

  const skillNames: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const sourceSkillPath = join(fromSkillsDir, entry.name, "SKILL.md")
    if (!(await Bun.file(sourceSkillPath).exists())) continue
    skillNames.push(entry.name)
  }
  skillNames.sort((a, b) => a.localeCompare(b))

  if (skillNames.length === 0) {
    console.log(`No ${fromAgent.name} skills with SKILL.md found at ${displayPath(fromSkillsDir)}.`)
    return
  }

  if (dryRun) {
    console.log(
      `Dry run: syncing ${fromAgent.name} → ${toAgent.name} skills (no files will be changed).`
    )
  } else {
    console.log(`Syncing ${fromAgent.name} → ${toAgent.name} skills.`)
    await mkdir(toSkillsDir, { recursive: true })
  }
  console.log(`Source: ${displayPath(fromSkillsDir)}`)
  console.log(`Target: ${displayPath(toSkillsDir)}\n`)

  let copied = 0
  let overwritten = 0
  let skipped = 0

  for (const name of skillNames) {
    const sourceDir = join(fromSkillsDir, name)
    const targetDir = join(toSkillsDir, name)
    const targetExists = existsSync(targetDir)

    if (targetExists && !overwrite) {
      skipped++
      console.log(`  - skipped ${name} (already exists)`)
      continue
    }

    if (dryRun) {
      if (targetExists) {
        overwritten++
        console.log(`  - would overwrite ${name}`)
      } else {
        copied++
        console.log(`  - would copy ${name}`)
      }
      continue
    }

    await cp(sourceDir, targetDir, { recursive: true, force: overwrite })
    if (targetExists) {
      overwritten++
      console.log(`  - overwritten ${name}`)
    } else {
      copied++
      console.log(`  - copied ${name}`)
    }
  }

  console.log(
    `\nSummary: ${copied} copied, ${overwritten} overwritten, ${skipped} skipped` +
      (!overwrite && skipped > 0 ? " (use --overwrite to replace existing targets)" : "")
  )
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
    const sync = args.includes("--sync")
    const syncGemini = args.includes("--sync-gemini")
    const convert = args.includes("--convert")
    const dryRun = args.includes("--dry-run")
    const overwrite = args.includes("--overwrite")

    if ((sync || syncGemini) && convert) {
      throw new Error("--sync/--sync-gemini and --convert are mutually exclusive.")
    }
    if (sync && syncGemini) {
      throw new Error("--sync and --sync-gemini are mutually exclusive.")
    }

    if (convert) {
      const fromIdx = args.indexOf("--from")
      const toIdx = args.indexOf("--to")
      if (fromIdx === -1 || !args[fromIdx + 1]) {
        throw new Error("--convert requires --from <agent>.")
      }
      if (toIdx === -1 || !args[toIdx + 1]) {
        throw new Error("--convert requires --to <agent>.")
      }
      const from = args[fromIdx + 1]!
      const to = args[toIdx + 1]!
      await convertSkills({ from, to, dryRun, overwrite })
      return
    }

    if (sync || syncGemini) {
      const positional = args.filter((a) => !a.startsWith("--"))
      if (positional.length > 0) {
        throw new Error("--sync/--sync-gemini does not accept a skill name.")
      }
      const fromIdx = args.indexOf("--from")
      const from = syncGemini ? "gemini" : (args[fromIdx + 1] ?? null)
      if (!from) {
        throw new Error("--sync requires --from <agent>.")
      }
      await syncSkills({ from, to: "claude", dryRun, overwrite })
      return
    }

    if (dryRun || overwrite) {
      throw new Error(
        "--dry-run and --overwrite are only valid with --sync, --sync-gemini, or --convert."
      )
    }

    const raw = args.includes("--raw")
    const noFrontMatter = args.includes("--no-front-matter")
    const flags = new Set(["--raw", "--no-front-matter"])
    const name = args.find((a) => !flags.has(a))
    if (!name) {
      await listSkills()
    } else {
      await readSkill(name, raw, noFrontMatter)
    }
  },
}
