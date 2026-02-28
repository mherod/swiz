import { findSkills, parseFrontmatterField, stripFrontmatter } from "../skill-utils.ts"
import type { Command } from "../types.ts"

export { parseFrontmatterField, stripFrontmatter }

const INLINE_CMD_RE = /!`([^`]+)`/g

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
        const stdout = await new Response(proc.stdout).text()
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

export const skillCommand: Command = {
  name: "skill",
  description: "Read and list skills",
  usage: "swiz skill [--raw] [--no-front-matter] [skill-name]",
  options: [
    { flags: "<skill-name>", description: "Print the skill content (omit to list all skills)" },
    { flags: "--raw", description: "Skip inline command expansion (!`cmd` substitutions)" },
    { flags: "--no-front-matter", description: "Strip YAML frontmatter from output" },
  ],
  async run(args) {
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
