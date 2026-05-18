/**
 * Shared skill usage detection helpers.
 *
 * These helpers intentionally cover both native Skill-tool invocations and
 * direct SKILL.md reads, because agents without a Skill tool load skills by
 * opening the skill file directly.
 */

export interface SkillUsageToolInput {
  args?: string
  command?: string
  cmd?: string
  file_path?: string
  path?: string
  paths?: string[]
  skill?: string
}

export interface SkillInvocationPreamble {
  /** Inferred skill name without a leading slash, when the preamble exposes it. */
  name: string | null
  /** Text before the skill body preamble, trimmed for display. */
  rest: string
}

const SKILL_MD_DIRECTORY_PATH_RE =
  /(?:^|[\\/])\.?skills[\\/](?:[^\\/\s"'`]+[\\/])*([a-z][a-z0-9-]*)[\\/]SKILL\.md\b/gi
const SKILL_MD_BASENAME_PATH_RE = /(?:^|[\\/])([a-z][a-z0-9-]*)[\\/]SKILL\.md\b/gi
const SKILL_MD_SHELL_READ_RE = /^(?:(?:cat|bat|less|more|head|tail|nl|grep|rg)\b|sed\s+-n\b)/i

const COMMAND_NAME_RE = /<command-name>([a-z][a-z0-9-]*)<\/command-name>/g
const QUEUED_SKILL_PROMPT_RE = /^\s*[/$]([a-z][a-z0-9-]*)\b/
const SKILL_DIR_BANNER_RE =
  /Base directory for this skill:\s*\S*?[\\/]skills[\\/]([a-z][a-z0-9-]*)\b/g
const SKILL_BASE_DIR_RE = /^Base directory for this skill:\s*(.+)$/im
const SKILL_BASE_DIR_START_RE = /^\s*Base directory for this skill:/i
const SKILL_CONTENT_HEAD_RE = /^SKILL CONTENT\s+(\S+)/im
const SKILL_CONTENT_START_RE = /^\s*SKILL CONTENT\s+\S+/i

function pushUniqueSkill(skills: string[], skill: string | undefined): void {
  if (skill && !skills.includes(skill)) skills.push(skill)
}

export function extractSkillNamesFromSkillMdPathText(
  text: string,
  options: { allowBasenamePath?: boolean } = {}
): string[] {
  const skills: string[] = []
  for (const match of text.matchAll(SKILL_MD_DIRECTORY_PATH_RE)) {
    pushUniqueSkill(skills, match[1])
  }
  if (!options.allowBasenamePath) return skills
  for (const match of text.matchAll(SKILL_MD_BASENAME_PATH_RE)) {
    pushUniqueSkill(skills, match[1])
  }
  return skills
}

export function extractSkillNameFromSkillMdPathText(
  text: string,
  options: { allowBasenamePath?: boolean } = {}
): string | null {
  return extractSkillNamesFromSkillMdPathText(text, options)[0] ?? null
}

export function isSkillMdShellReadCommand(command: string): boolean {
  return SKILL_MD_SHELL_READ_RE.test(command.trim())
}

export function extractSkillNamesFromShellSkillReadCommand(command: string): string[] {
  if (!isSkillMdShellReadCommand(command)) return []
  return extractSkillNamesFromSkillMdPathText(command, { allowBasenamePath: true })
}

export function extractSkillNameFromToolInput(
  input: SkillUsageToolInput | undefined
): string | null {
  const skill = input?.skill
  if (typeof skill !== "string") return null
  const trimmed = skill.trim()
  return trimmed || null
}

export function formatSkillToolInputDetail(input: SkillUsageToolInput | undefined): string | null {
  const skill = extractSkillNameFromToolInput(input)
  if (!skill) return null
  return typeof input?.args === "string" && input.args ? `${skill} ${input.args}` : skill
}

export function extractPathValuesFromToolInput(input: SkillUsageToolInput | undefined): string[] {
  if (!input) return []
  const paths = [input.file_path, input.path].filter((value): value is string => Boolean(value))
  if (Array.isArray(input.paths)) paths.push(...input.paths.filter(Boolean))
  return paths
}

export function extractSkillNamesFromPathValues(paths: string[]): string[] {
  const skills: string[] = []
  for (const path of paths) {
    for (const skill of extractSkillNamesFromSkillMdPathText(path)) {
      pushUniqueSkill(skills, skill)
    }
  }
  return skills
}

export function extractSkillNameFromCapturedSkillDetail(detail: string): string | null {
  const trimmed = detail.trim()
  if (!trimmed) return null
  const [skill] = trimmed.split(/\s+/, 1)
  return skill || null
}

export function extractSkillNamesFromLegacyCommandTags(text: string): string[] {
  if (!text) return []
  const skills: string[] = []
  for (const match of text.matchAll(COMMAND_NAME_RE)) {
    if (match[1]) skills.push(match[1])
  }
  return skills
}

export function extractSkillNamesFromActivationBanner(text: string): string[] {
  if (!text) return []
  const skills: string[] = []
  for (const match of text.matchAll(SKILL_DIR_BANNER_RE)) {
    if (match[1]) skills.push(match[1])
  }
  return skills
}

export function extractSkillNameFromSlashPrompt(text: string | undefined | null): string | null {
  if (!text) return null
  const match = QUEUED_SKILL_PROMPT_RE.exec(text)
  return match?.[1] ?? null
}

export function stripUserQueryWrapper(text: string): string {
  const match = text.match(/^\s*<user_query>\s*([\s\S]*?)\s*<\/user_query>\s*$/)
  return match?.[1]?.trim() ?? text
}

export function startsWithSkillInvocationPreamble(text: string): boolean {
  return SKILL_BASE_DIR_START_RE.test(text) || SKILL_CONTENT_START_RE.test(text)
}

function lastPathSegment(path: string): string | null {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? null
}

export function extractSkillInvocationPreamble(text: string): SkillInvocationPreamble | null {
  const baseMatch = SKILL_BASE_DIR_RE.exec(text)
  if (baseMatch) {
    const path = baseMatch[1]!.trim()
    return { name: lastPathSegment(path), rest: text.slice(0, baseMatch.index).trim() }
  }

  const headMatch = SKILL_CONTENT_HEAD_RE.exec(text)
  if (headMatch) {
    return { name: headMatch[1]!.trim() || null, rest: text.slice(0, headMatch.index).trim() }
  }

  return null
}

export function extractSkillNamesFromUserText(text: string): string[] {
  const skills = extractSkillNamesFromActivationBanner(text)
  skills.push(...extractSkillNamesFromLegacyCommandTags(text))
  const promptedSkill = extractSkillNameFromSlashPrompt(text)
  if (promptedSkill) skills.push(promptedSkill)
  return skills
}
