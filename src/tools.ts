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
import { messageFromUnknownError } from "./utils/hook-json-helpers.ts"
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
      return { error: messageFromUnknownError(err) }
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
      return { error: messageFromUnknownError(err) }
    }
  },
})

async function resolveSkillOrError(
  name: string
): Promise<{ skill: Awaited<ReturnType<typeof findSkills>>[number] } | { error: string }> {
  const skills = await findSkills()
  const skill = skills.find((s) => s.name === name)
  if (!skill) {
    const available = skills.map((s) => s.name).join(", ")
    return { error: `Skill not found: ${name}. Available skills: ${available}` }
  }
  return { skill }
}

function convertSkillForAgents(
  content: string,
  from_agent: string | undefined,
  warnings: string[]
): { content: string; error?: string } {
  const activeAgent = detectCurrentAgent() ?? getAgent("claude")!
  const sourceAgent = from_agent ? getAgent(from_agent) : activeAgent

  if (!sourceAgent) {
    return {
      content,
      error: `Unknown agent: ${from_agent}. Valid: ${AGENTS.map((a) => a.id).join(", ")}`,
    }
  }

  if (sourceAgent.id !== activeAgent.id) {
    const conversionResult = convertSkillContent(content, sourceAgent, activeAgent, AGENTS)
    if (conversionResult.unmapped.length > 0) {
      warnings.push(
        `⚠ Unmapped tools: ${conversionResult.unmapped.join(", ")} (no equivalent in ${activeAgent.id})`
      )
    }
    return { content: conversionResult.content }
  }

  return { content }
}

async function prepareSkillOutput(
  rawContent: string,
  name: string,
  args: string,
  from_agent?: string,
  strip_frontmatter = false
): Promise<{
  description: string
  category?: string
  content: string
  warnings?: string[]
  error?: string
}> {
  const warnings: string[] = []
  const availabilityWarning = getSkillToolAvailabilityWarning(name, rawContent)
  if (availabilityWarning) {
    warnings.push(availabilityWarning.message)
  }

  const description = parseFrontmatterField(rawContent, "description") ?? ""
  const category = parseFrontmatterField(rawContent, "category") ?? ""

  const positionalArgs = args ? args.split(/\s+/) : []
  let content = substituteArgs(rawContent, positionalArgs)

  const conversion = convertSkillForAgents(content, from_agent, warnings)
  if (conversion.error) return { description, content, error: conversion.error }
  content = conversion.content

  content = await expandInlineCommands(content)
  if (strip_frontmatter) {
    content = stripFrontmatter(content)
  }

  return {
    description,
    category: category || undefined,
    content,
    warnings: warnings.length > 0 ? warnings : undefined,
  }
}

export const skillTool = tool({
  description:
    "Load a dynamic skill into context. Skills are modular capability bundles containing instructions, examples, and scripts. If the requested skill is not available, the tool returns the list of all available skill names.",
  inputSchema: z.object({
    name: z.string().describe("Skill name (e.g. 'firebase-basics', 'commit')"),
    args: z
      .string()
      .optional()
      .describe(
        "Optional arguments passed to the skill (e.g. '123' for an issue number). Replaces $ARGUMENTS, $1, $2... in the skill content."
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
      const resolved = await resolveSkillOrError(name)
      if ("error" in resolved) return { error: resolved.error }
      const { skill } = resolved

      const rawContent = await Bun.file(skill.path).text()
      const prepared = await prepareSkillOutput(
        rawContent,
        name,
        args,
        from_agent,
        strip_frontmatter
      )
      if (prepared.error) return { error: prepared.error }

      return {
        name: skill.name,
        source: skill.source,
        path: skill.path,
        description: prepared.description,
        category: prepared.category,
        content: prepared.content,
        warnings: prepared.warnings,
      }
    } catch (err) {
      return { error: messageFromUnknownError(err) }
    }
  },
})
