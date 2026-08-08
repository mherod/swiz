import { type ToolHookInput, toolHookInputSchema } from "./schemas.ts"
import {
  formatSkillFileReadFallback,
  getRecentlyInvokedSkillsForCurrentSession,
  type ResolvedSkillFile,
  resolveSkillFilePathForHookPayload,
  resolveSkillRecencyOptions,
} from "./skill-utils.ts"

export function formatActiveSkillsContext(
  skills: string[],
  windowText: string,
  skillFiles: readonly ResolvedSkillFile[] = []
): string {
  const active = `Recently active skills (${windowText}): ${skills.map((skill) => `/${skill}`).join(", ")}.`
  return skillFiles.length > 0 ? `${active}\n${formatSkillFileReadFallback(skillFiles)}` : active
}

export async function resolveActiveSkillsContext(
  input: ToolHookInput,
  options: { includeVerifiedSkillPaths?: boolean } = {}
): Promise<string | null> {
  try {
    const hookInput: ToolHookInput = toolHookInputSchema.parse(input)
    const cwd = hookInput.cwd ?? process.cwd()
    const { recencyOptions, windowText } = await resolveSkillRecencyOptions(cwd)
    const skills = await getRecentlyInvokedSkillsForCurrentSession(hookInput, recencyOptions)
    if (skills.length === 0) return null
    const skillFiles = options.includeVerifiedSkillPaths
      ? skills.flatMap((name) => {
          const path = resolveSkillFilePathForHookPayload(name, hookInput, cwd)
          return path ? [{ name, path }] : []
        })
      : []
    return formatActiveSkillsContext(skills, windowText, skillFiles)
  } catch {
    return null
  }
}
