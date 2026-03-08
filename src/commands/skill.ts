import { existsSync } from "node:fs"
import { cp, mkdir, readdir } from "node:fs/promises"
import { join } from "node:path"
import { AGENTS, getAgent } from "../agents.ts"
import { getHomeDir } from "../home.ts"
import { getProviderAdapter } from "../provider-adapters.ts"
import { findSkills, parseFrontmatterField, stripFrontmatter } from "../skill-utils.ts"
import type { Command } from "../types.ts"

export { parseFrontmatterField, stripFrontmatter }

const INLINE_CMD_RE = /!`([^`]+)`/g
const HOME = getHomeDir()

function primarySkillDir(agentId: "claude" | "gemini"): string {
  const adapter = getProviderAdapter(agentId)
  const primary = adapter?.getSkillDirs()[0]
  if (primary) return primary

  const configDir = agentId === "claude" ? ".claude" : ".gemini"
  return join(HOME, configDir, "skills")
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
  const unmapped: string[] = []
  const result = list
    .split(",")
    .map((raw) => {
      const tool = raw.trim()
      if (!tool) return raw
      const mapped = remap(tool)
      if (mapped === tool) unmapped.push(tool)
      return mapped
    })
    .join(", ")
  return { result, unmapped }
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

  /** Resolve a single tool token: source-specific → canonical → target-specific */
  function remap(tool: string): string {
    const canonical = reverseFrom[tool] ?? tool // source → canonical
    return toAliases[canonical] ?? canonical // canonical → target (identity if absent)
  }

  const unmappedSet = new Set<string>()

  // ── Rewrite frontmatter allowed-tools field ──────────────────────────────
  // Matches: `allowed-tools: Bash, Edit, Write` (inline list on one line)
  let result = content.replace(/^(allowed-tools\s*:\s*)(.+)$/m, (_match, prefix, list) => {
    const { result: remapped, unmapped } = remapToolList(list, remap)
    for (const u of unmapped) unmappedSet.add(u)
    return `${prefix}${remapped}`
  })

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

  const fromAdapter = getProviderAdapter(from as "claude" | "gemini")
  const toAdapter = getProviderAdapter(to as "claude" | "gemini")
  const fromSkillsDir = fromAdapter?.getSkillDirs()[0] ?? join(HOME, `.${from}`, "skills")
  const toSkillsDir = toAdapter?.getSkillDirs()[0] ?? join(HOME, `.${to}`, "skills")

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

async function syncGeminiSkills(options: { dryRun: boolean; overwrite: boolean }): Promise<void> {
  const { dryRun, overwrite } = options
  const geminiSkillsDir = primarySkillDir("gemini")
  const claudeSkillsDir = primarySkillDir("claude")

  let entries: import("node:fs").Dirent[]
  try {
    entries = await readdir(geminiSkillsDir, { withFileTypes: true })
  } catch {
    console.log(`No Gemini skills found at ${displayPath(geminiSkillsDir)}.`)
    return
  }

  const skillNames: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const sourceSkillPath = join(geminiSkillsDir, entry.name, "SKILL.md")
    if (!(await Bun.file(sourceSkillPath).exists())) continue
    skillNames.push(entry.name)
  }
  skillNames.sort((a, b) => a.localeCompare(b))

  if (skillNames.length === 0) {
    console.log(`No Gemini skills with SKILL.md found at ${displayPath(geminiSkillsDir)}.`)
    return
  }

  if (dryRun) {
    console.log("Dry run: syncing Gemini skills to Claude skills (no files will be changed).")
  } else {
    console.log("Syncing Gemini skills to Claude skills.")
    await mkdir(claudeSkillsDir, { recursive: true })
  }
  console.log(`Source: ${displayPath(geminiSkillsDir)}`)
  console.log(`Target: ${displayPath(claudeSkillsDir)}\n`)

  let copied = 0
  let overwritten = 0
  let skipped = 0

  for (const name of skillNames) {
    const sourceDir = join(geminiSkillsDir, name)
    const targetDir = join(claudeSkillsDir, name)
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
    "swiz skill [--raw] [--no-front-matter] [skill-name] | --sync-gemini [--dry-run] [--overwrite] | --convert --from <agent> --to <agent> [--dry-run] [--overwrite]",
  options: [
    { flags: "<skill-name>", description: "Print the skill content (omit to list all skills)" },
    { flags: "--raw", description: "Skip inline command expansion (!`cmd` substitutions)" },
    { flags: "--no-front-matter", description: "Strip YAML frontmatter from output" },
    {
      flags: "--sync-gemini",
      description:
        "Copy ~/.gemini/skills into ~/.claude/skills (copy-only; no tool name remapping — use --convert for that)",
    },
    {
      flags: "--convert",
      description: "Convert skills between agents, remapping tool names to target equivalents",
    },
    {
      flags: "--from <agent>",
      description: "Source agent ID for --convert (claude|cursor|gemini|codex)",
    },
    {
      flags: "--to <agent>",
      description: "Target agent ID for --convert (claude|cursor|gemini|codex)",
    },
    { flags: "--dry-run", description: "Preview actions without writing files" },
    { flags: "--overwrite", description: "Allow overwriting existing target skills" },
  ],
  async run(args) {
    const syncGemini = args.includes("--sync-gemini")
    const convert = args.includes("--convert")
    const dryRun = args.includes("--dry-run")
    const overwrite = args.includes("--overwrite")

    if (syncGemini && convert) {
      throw new Error("--sync-gemini and --convert are mutually exclusive.")
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

    if (syncGemini) {
      const positional = args.filter((a) => !a.startsWith("--"))
      if (positional.length > 0) {
        throw new Error("--sync-gemini does not accept a skill name.")
      }
      await syncGeminiSkills({ dryRun, overwrite })
      return
    }

    if (dryRun || overwrite) {
      throw new Error("--dry-run and --overwrite are only valid with --sync-gemini or --convert.")
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
