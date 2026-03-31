// Tool implementations for auto-reply model to examine files
import { tool } from "ai"
import { z } from "zod"
import { AGENTS, getAgent } from "./agents.ts"
import { detectCurrentAgent } from "./detect.ts"
import {
  findSkills,
  getSkillToolAvailabilityWarning,
  parseFrontmatterField,
  stripFrontmatter,
} from "./skill-utils.ts"
import { expandInlineCommands, substituteArgs } from "./utils/skill-content.ts"
import { convertSkillContent } from "./utils/skill-conversion.ts"

export const readTool = tool({
  description: "Read the contents of a file",
  inputSchema: z.object({
    file_path: z.string().describe("Path to the file to read"),
    offset: z.number().optional().describe("Starting line number (1-based)"),
    limit: z.number().optional().describe("Maximum number of lines to read"),
  }),
  execute: async ({ file_path, offset, limit }) => {
    try {
      const file = Bun.file(file_path)
      if (!(await file.exists())) {
        return { error: `File not found: ${file_path}` }
      }
      const lines = (await file.text()).split("\n")
      const start = offset ? offset - 1 : 0
      const end = limit ? start + limit : lines.length
      return {
        content: lines.slice(start, end).join("\n"),
        totalLines: lines.length,
        shown: `${start + 1}-${Math.min(end, lines.length)}`,
      }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  },
})

export const grepTool = tool({
  description: "Search for a pattern in files using ripgrep",
  inputSchema: z.object({
    pattern: z.string().describe("The regex pattern to search for"),
    path: z.string().optional().describe("Directory or file path to search in"),
    glob: z.string().optional().describe("Glob filter for files (e.g., '*.ts')"),
    maxResults: z.number().optional().describe("Maximum number of results (default: 20)"),
  }),
  execute: async ({ pattern, path, glob, maxResults = 20 }) => {
    try {
      const args = [
        "rg",
        "--line-number",
        "--no-heading",
        "--color=never",
        "-m",
        String(maxResults),
      ]
      if (glob) args.push("--glob", glob)
      args.push(pattern)
      if (path) args.push(path)
      const proc = Bun.spawn(args, {
        cwd: process.cwd(),
        stderr: "pipe",
        stdout: "pipe",
      })
      const output = await new Response(proc.stdout).text()
      const stderr = await new Response(proc.stderr).text()
      await proc.exited
      if (proc.exitCode === 0) {
        return { matches: output.trim(), count: output.split("\n").filter(Boolean).length }
      } else if (proc.exitCode === 1) {
        return { matches: "", count: 0, message: "No matches found" }
      } else {
        return { error: stderr || `ripgrep failed with exit code ${proc.exitCode}` }
      }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  },
})

export const skillTool = tool({
  description:
    "Load and render a skill by name. Skills are reusable instruction sets (SKILL.md) that guide how to perform specific tasks. Returns the rendered skill content ready for execution.",
  inputSchema: z.object({
    name: z.string().describe("Skill name (e.g., 'commit', 'push', 'test')"),
    args: z
      .string()
      .optional()
      .describe(
        "Arguments to pass to the skill (space-separated, used in $0, $1, $ARGUMENTS substitution)"
      ),
    from_agent: z
      .string()
      .optional()
      .describe("Source agent for content conversion (defaults to current agent)"),
    strip_frontmatter: z
      .boolean()
      .optional()
      .describe("Remove YAML frontmatter from output (default: false)"),
  }),
  execute: async ({ name, args = "", from_agent, strip_frontmatter = false }) => {
    try {
      // Check skill exists
      const skills = await findSkills()
      const skill = skills.find((s) => s.name === name)
      if (!skill) {
        const available = skills.map((s) => s.name).join(", ")
        return {
          error: `Skill not found: ${name}. Available skills: ${available}`,
        }
      }

      // Read raw content
      let content = await Bun.file(skill.path).text()

      // Check tool availability warnings
      const warnings: string[] = []
      const availabilityWarning = getSkillToolAvailabilityWarning(name, content)
      if (availabilityWarning) {
        warnings.push(availabilityWarning.message)
      }

      // Get metadata
      const description = parseFrontmatterField(content, "description") ?? ""
      const category = parseFrontmatterField(content, "category") ?? ""

      // Substituting arguments before conversion
      const positionalArgs = args ? args.split(/\s+/) : []
      content = substituteArgs(content, positionalArgs)

      // Convert between agents if requested
      const activeAgent = detectCurrentAgent() ?? getAgent("claude")!
      const sourceAgent = from_agent ? getAgent(from_agent) : activeAgent

      if (!sourceAgent) {
        return {
          error: `Unknown agent: ${from_agent}. Valid: ${AGENTS.map((a) => a.id).join(", ")}`,
        }
      }

      if (sourceAgent.id !== activeAgent.id) {
        const conversionResult = convertSkillContent(content, sourceAgent, activeAgent, AGENTS)
        content = conversionResult.content
        if (conversionResult.unmapped.length > 0) {
          warnings.push(
            `⚠ Unmapped tools: ${conversionResult.unmapped.join(", ")} (no equivalent in ${activeAgent.id})`
          )
        }
      }

      // Expand inline commands
      content = await expandInlineCommands(content)

      // Strip frontmatter if requested
      if (strip_frontmatter) {
        content = stripFrontmatter(content)
      }

      return {
        name: skill.name,
        source: skill.source,
        path: skill.path,
        description,
        category: category || undefined,
        content,
        warnings: warnings.length > 0 ? warnings : undefined,
      }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  },
})
