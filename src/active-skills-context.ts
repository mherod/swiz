import { type ToolHookInput, toolHookInputSchema } from "./schemas.ts"
import {
  getRecentlyInvokedSkillsForCurrentSession,
  resolveSkillRecencyOptions,
} from "./skill-utils.ts"

export function formatActiveSkillsContext(skills: string[], windowText: string): string {
  return `Recently active skills (${windowText}): ${skills.map((skill) => `/${skill}`).join(", ")}.`
}

export async function resolveActiveSkillsContext(input: ToolHookInput): Promise<string | null> {
  try {
    const hookInput: ToolHookInput = toolHookInputSchema.parse(input)
    const cwd = hookInput.cwd ?? process.cwd()
    const { recencyOptions, windowText } = await resolveSkillRecencyOptions(cwd)
    const skills = await getRecentlyInvokedSkillsForCurrentSession(hookInput, recencyOptions)
    return skills.length > 0 ? formatActiveSkillsContext(skills, windowText) : null
  } catch {
    return null
  }
}
