import { existsSync } from "node:fs"
import { cp, mkdir, readdir } from "node:fs/promises"
import { join } from "node:path"
import { getProviderAdapter } from "../provider-adapters.ts"
import { findSkills, parseFrontmatterField, stripFrontmatter } from "../skill-utils.ts"
import type { Command } from "../types.ts"

export { parseFrontmatterField, stripFrontmatter }

const INLINE_CMD_RE = /!`([^`]+)`/g
const HOME = process.env.HOME ?? "~"

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
  description: "Read, list, and sync skills",
  usage:
    "swiz skill [--raw] [--no-front-matter] [skill-name] | --sync-gemini [--dry-run] [--overwrite]",
  options: [
    { flags: "<skill-name>", description: "Print the skill content (omit to list all skills)" },
    { flags: "--raw", description: "Skip inline command expansion (!`cmd` substitutions)" },
    { flags: "--no-front-matter", description: "Strip YAML frontmatter from output" },
    {
      flags: "--sync-gemini",
      description: "Copy ~/.gemini/skills into ~/.claude/skills with non-destructive defaults",
    },
    { flags: "--dry-run", description: "Preview sync actions without writing files" },
    { flags: "--overwrite", description: "Allow sync to overwrite existing target skills" },
  ],
  async run(args) {
    const syncGemini = args.includes("--sync-gemini")
    const dryRun = args.includes("--dry-run")
    const overwrite = args.includes("--overwrite")

    if (syncGemini) {
      const positional = args.filter((a) => !a.startsWith("--"))
      if (positional.length > 0) {
        throw new Error("--sync-gemini does not accept a skill name.")
      }
      await syncGeminiSkills({ dryRun, overwrite })
      return
    }

    if (dryRun || overwrite) {
      throw new Error("--dry-run and --overwrite are only valid with --sync-gemini.")
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
