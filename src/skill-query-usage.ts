/** Recognize skill content loads without executing code from a transcript. */
interface SkillQueryUsageInput {
  name?: string
  action?: string
  query?: string
  limit?: number
  offset?: number
  code?: string
  input?: string
}

const SKILL_QUERY_TOOL_RE = /^(?:functions\.)?(?:mcp__swiz(?:__|\.))?SkillQuery$/
const CODE_TOKENS_RE =
  /\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[\w$]+|[^\s]/g

export function extractSkillNameFromSkillQuery(
  toolName: string,
  input: SkillQueryUsageInput | undefined
): string | null {
  if (!SKILL_QUERY_TOOL_RE.test(toolName) || typeof input?.name !== "string") return null
  if (input.action !== undefined && input.action !== "read") return null
  if ([input.query, input.limit, input.offset].some((value) => value !== undefined)) return null
  return input.name.trim() || null
}

function stringLiteral(token: string): string | null {
  if (token.startsWith('"')) {
    try {
      return JSON.parse(token) as string
    } catch {
      return null
    }
  }
  if (!/^['`]/.test(token) || token.includes("${")) return null
  // Conservative for JavaScript-only escapes; never infer a different skill name.
  if (/\\[^\\'`]/.test(token)) return null
  return token.slice(1, -1).replace(/\\([\\'`])/g, "$1")
}

function queryObjectStart(tokens: string[], index: number): number {
  if (tokens[index] !== "tools" || tokens[index - 1] === ".") return -1
  let name = tokens[index + 2] ?? ""
  let end = index + 3
  if (tokens[index + 1] === "[" && tokens[index + 3] === "]") {
    name = stringLiteral(name) ?? ""
    end++
  } else if (tokens[index + 1] !== ".") return -1
  if (!SKILL_QUERY_TOOL_RE.test(name)) return -1
  const callPrefix = tokens.slice(end, end + 2).join("")
  return callPrefix === "({" ? end + 1 : -1
}

function objectEnd(tokens: string[], start: number): number {
  let depth = 0
  for (let index = start; index < tokens.length; index++) {
    if (tokens[index] === "{") depth++
    if (tokens[index] === "}" && --depth === 0) return index
  }
  return -1
}

function jsonToken(token: string, next: string | undefined): string {
  if (/^["'`]/.test(token)) {
    const value = stringLiteral(token)
    return value === null ? token : JSON.stringify(value)
  }
  return /^[a-zA-Z_$][\w$]*$/.test(token) && next === ":" ? JSON.stringify(token) : token
}

function skillFromObjectTokens(tokens: string[]): string | null {
  const json = tokens
    .filter((token, index) => token !== "," || !["}", "]"].includes(tokens[index + 1] ?? ""))
    .map((token, index, filtered) => jsonToken(token, filtered[index + 1]))
    .join("")
  try {
    return extractSkillNameFromSkillQuery("SkillQuery", JSON.parse(json) as SkillQueryUsageInput)
  } catch {
    // Dynamic expressions and spreads cannot establish a particular skill read.
    return null
  }
}

/** Literal MCP calls inside Codex exec; quoted examples and comments are ignored. */
export function extractSkillNamesFromCodexSkillQueryCode(code: string): string[] {
  const tokens = (code.match(CODE_TOKENS_RE) ?? []).filter((token) => !/^\/(?:\/|\*)/.test(token))
  const skills = new Set<string>()
  for (let index = 0; index < tokens.length; index++) {
    const start = queryObjectStart(tokens, index)
    if (start < 0) continue
    const end = objectEnd(tokens, start)
    if (end < 0 || tokens[end + 1] !== ")") continue
    const skill = skillFromObjectTokens(tokens.slice(start, end + 1))
    if (skill) skills.add(skill)
  }
  return [...skills]
}

export function extractSkillQueryNames(
  toolName: string,
  input: SkillQueryUsageInput | undefined
): string[] {
  if (toolName === "exec" || toolName === "functions.exec") {
    return extractSkillNamesFromCodexSkillQueryCode(input?.code ?? input?.input ?? "")
  }
  const skill = extractSkillNameFromSkillQuery(toolName, input)
  return skill ? [skill] : []
}
