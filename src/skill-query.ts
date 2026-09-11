import { z } from "zod"
import { findSkills, type SkillInfo, stripFrontmatter } from "./skill-utils.ts"
import { substituteArgs } from "./utils/skill-content.ts"

export const skillQueryInputSchema = z.strictObject({
  action: z
    .enum(["list", "lookup", "read"])
    .optional()
    .describe("Defaults to read when name is supplied, otherwise list"),
  name: z.string().trim().min(1).optional().describe("Exact skill name for lookup or read"),
  query: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Filter the index by name or description, case-insensitively"),
  offset: z.number().int().min(0).optional().describe("Index offset; defaults to 0"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe("Index page size; defaults to 50, maximum 200"),
  args: z
    .array(z.string())
    .optional()
    .describe("Read only: replace $ARGUMENTS and positional $0, $1, ..."),
  noFrontMatter: z
    .boolean()
    .optional()
    .describe("Read only: omit YAML frontmatter; defaults to false"),
})

const skillInfoSchema = z.object({
  name: z.string(),
  description: z.string(),
  source: z.enum(["local", "global"]),
  path: z.string(),
})

export const skillQueryResultSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("list"),
    skills: z.array(skillInfoSchema),
    total: z.number().int().min(0),
    offset: z.number().int().min(0),
    limit: z.number().int().positive(),
    nextOffset: z.number().int().min(0).nullable(),
  }),
  z.object({ action: z.literal("lookup"), skill: skillInfoSchema }),
  z.object({ action: z.literal("read"), skill: skillInfoSchema, content: z.string() }),
])

type SkillQueryInput = z.infer<typeof skillQueryInputSchema>
export type SkillQueryResult = z.infer<typeof skillQueryResultSchema>

interface SkillQueryDependencies {
  discover: (cwd: string) => Promise<SkillInfo[]>
  read: (path: string) => Promise<string>
}

const defaultDependencies: SkillQueryDependencies = {
  discover: findSkills,
  read: (path) => Bun.file(path).text(),
}

function resolveAction(input: SkillQueryInput): "list" | "lookup" | "read" {
  const action = input.action ?? (input.name ? "read" : "list")
  if (action === "list" && input.name !== undefined) {
    throw new Error("Use query to filter the index, or lookup/read with an exact name.")
  }
  if (action !== "list" && input.name === undefined) {
    throw new Error(`${action} requires an exact skill name.`)
  }
  validateActionOptions(action, input)
  return action
}

function validateActionOptions(action: "list" | "lookup" | "read", input: SkillQueryInput): void {
  if (action !== "list" && [input.query, input.limit, input.offset].some((v) => v !== undefined)) {
    throw new Error("query, limit and offset apply only to list.")
  }
  if (action !== "read" && [input.args, input.noFrontMatter].some((v) => v !== undefined)) {
    throw new Error("args and noFrontMatter apply only to read.")
  }
}

function queryIndex(skills: SkillInfo[], input: SkillQueryInput): SkillQueryResult {
  const query = input.query?.toLowerCase()
  const matches = query
    ? skills.filter((skill) => `${skill.name}\n${skill.description}`.toLowerCase().includes(query))
    : skills
  const offset = input.offset ?? 0
  const limit = input.limit ?? 50
  const page = matches.slice(offset, offset + limit)
  const end = offset + page.length
  return {
    action: "list",
    skills: page,
    total: matches.length,
    offset,
    limit,
    nextOffset: end < matches.length ? end : null,
  }
}

/** Read-only CLI discovery and content transforms, scoped to the requesting project. */
export async function querySkills(
  rawInput: object,
  cwd: string,
  dependencies: SkillQueryDependencies = defaultDependencies
): Promise<SkillQueryResult> {
  const input = skillQueryInputSchema.parse(rawInput)
  const action = resolveAction(input)
  const skills = await dependencies.discover(cwd)
  if (action === "list") return queryIndex(skills, input)
  const skill = skills.find((candidate) => candidate.name === input.name)
  if (!skill)
    throw new Error(
      `Skill not found: ${input.name}. Use SkillQuery with query to search the index.`
    )
  if (action === "lookup") return { action, skill }
  // Queries never expand inline shell commands or run skill setup instructions.
  const substituted = substituteArgs(await dependencies.read(skill.path), input.args ?? [])
  const content = input.noFrontMatter ? stripFrontmatter(substituted) : substituted
  return { action, skill, content }
}

export function renderSkillQuery(result: SkillQueryResult): string {
  if (result.action === "read") return result.content
  if (result.action === "lookup") return JSON.stringify(result.skill, null, 2)
  if (result.total === 0) return "No skills found."
  const lines = result.skills.map(
    (skill) => `${skill.name}: ${skill.description} (${skill.source})`
  )
  const heading = `${result.skills.length} of ${result.total} skills (offset ${result.offset}).`
  const next = result.nextOffset === null ? [] : [`Next page: offset ${result.nextOffset}.`]
  return [heading, ...lines, ...next].join("\n")
}
