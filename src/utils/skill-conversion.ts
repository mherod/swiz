import { parseQuotedString, transformQuotedString } from "./quoted-string.ts"

// ─── Conversion result type ──────────────────────────────────────────────────

export interface ConversionResult {
  content: string
  /** Tool names that exist in the source but have no mapping in the target */
  unmapped: string[]
}

// ─── Tool name remapping ─────────────────────────────────────────────────────

/**
 * Build a reverse alias map: agent-specific tool name → canonical (Claude) name.
 * Claude's toolAliases is `{}`, so for Claude as source the reverse map is empty
 * (agent name == canonical name already).
 */
export function buildReverseMap(toolAliases: Record<string, string>): Record<string, string> {
  const rev: Record<string, string> = {}
  for (const [canonical, agentSpecific] of Object.entries(toolAliases)) {
    rev[agentSpecific] = canonical
  }
  return rev
}

function remapPossiblyQuotedTool(
  raw: string,
  remap: (tool: string) => string
): { mappedRaw: string; unmapped?: string } {
  const { quoteChar, content } = parseQuotedString(raw)
  const mapped = remap(content)
  return {
    mappedRaw: quoteChar ? `${quoteChar}${mapped}${quoteChar}` : mapped,
    unmapped: mapped === content ? content : undefined,
  }
}

function remapToken(
  raw: string,
  remap: (tool: string) => string
): { token: string; unmapped?: string } {
  const { result, unmapped } = transformQuotedString(raw, remap)
  return { token: result, unmapped }
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
      if (!raw.trim()) return raw
      const { token, unmapped: u } = remapToken(raw, remap)
      if (u) unmapped.push(u)
      return token
    })
    .join(", ")
  return { result, unmapped }
}

function remapAllowedToolsBlock(
  frontmatterLines: string[],
  startIndex: number,
  remap: (tool: string) => string
): { lines: string[]; nextIndex: number; unmapped: string[] } {
  const lines: string[] = []
  const unmapped: string[] = []
  let index = startIndex

  while (index < frontmatterLines.length) {
    const listLine = frontmatterLines[index]!
    const itemMatch = listLine.match(/^(\s*-\s*)(.+)$/)
    if (!itemMatch) break

    const { mappedRaw, unmapped: unmatchedTool } = remapPossiblyQuotedTool(itemMatch[2]!, remap)
    if (unmatchedTool) unmapped.push(unmatchedTool)
    lines.push(`${itemMatch[1]}${mappedRaw}`)
    index++
  }

  return { lines, nextIndex: index, unmapped }
}

export function remapAllowedToolsFrontmatter(
  content: string,
  remap: (tool: string) => string
): { result: string; unmapped: string[] } {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---([ \t]*\n?)/)
  if (!frontmatterMatch) return { result: content, unmapped: [] }

  const fullMatch = frontmatterMatch[0]
  const frontmatterBody = frontmatterMatch[1] ?? ""
  const frontmatterLines = frontmatterBody.split("\n")
  const unmapped: string[] = []

  const remappedLines: string[] = []
  for (let i = 0; i < frontmatterLines.length; i++) {
    const line = frontmatterLines[i]!
    const inlineMatch = line.match(/^(allowed-tools\s*:\s*)(.+)$/)
    if (inlineMatch) {
      const { result: remapped, unmapped: inlineUnmapped } = remapToolList(inlineMatch[2]!, remap)
      for (const u of inlineUnmapped) unmapped.push(u)
      remappedLines.push(`${inlineMatch[1]}${remapped}`)
      continue
    }

    const blockMatch = line.match(/^(allowed-tools\s*:\s*)$/)
    if (!blockMatch) {
      remappedLines.push(line)
      continue
    }

    remappedLines.push(line)
    const blockResult = remapAllowedToolsBlock(frontmatterLines, i + 1, remap)
    remappedLines.push(...blockResult.lines)
    unmapped.push(...blockResult.unmapped)
    i = blockResult.nextIndex - 1
  }

  const remappedFrontmatter = `---\n${remappedLines.join("\n")}\n---${frontmatterMatch[2] ?? ""}`
  return {
    result: content.replace(fullMatch, remappedFrontmatter),
    unmapped,
  }
}

// ─── Body-level tool name rewriting ──────────────────────────────────────────

function collectSourceToolNames(
  fromAgent: { toolAliases: Record<string, string> },
  supplement: Record<string, string>,
  allAgents: { toolAliases: Record<string, string> }[]
): Set<string> {
  const names = new Set<string>([
    ...Object.keys(fromAgent.toolAliases),
    ...Object.values(fromAgent.toolAliases),
  ])
  for (const agent of allAgents) {
    for (const canonical of Object.keys(agent.toolAliases)) names.add(canonical)
  }
  for (const canonical of Object.keys(supplement)) names.add(canonical)
  return names
}

function rewriteBodyToolNames(
  text: string,
  fromAgent: { toolAliases: Record<string, string> },
  supplement: Record<string, string>,
  allAgents: { toolAliases: Record<string, string> }[],
  remapFn: (tool: string) => string
): string {
  let result = text
  for (const sourceName of collectSourceToolNames(fromAgent, supplement, allAgents)) {
    const mapped = remapFn(sourceName)
    if (mapped === sourceName) continue
    const escaped = sourceName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    result = result.replace(new RegExp(`\\b${escaped}\\b`, "g"), mapped)
  }
  return result
}

// ─── Public: convert skill content between agents ────────────────────────────

export function convertSkillContent(
  content: string,
  fromAgent: { id: string; toolAliases: Record<string, string> },
  toAgent: { id: string; toolAliases: Record<string, string> },
  allAgents: { toolAliases: Record<string, string> }[]
): ConversionResult {
  if (fromAgent.id === toAgent.id) return { content, unmapped: [] }

  const reverseFrom = buildReverseMap(fromAgent.toolAliases)
  const toAliases = toAgent.toolAliases

  // Conversion-only supplement: read-only task tools (TaskList, TaskGet) are
  // intentionally absent from toolAliases (they must pass through in hook
  // contexts) but should be remapped during skill conversion to the same
  // target as TaskCreate, if one exists.
  const taskCreateTarget = toAliases.TaskCreate
  const conversionSupplement: Record<string, string> = taskCreateTarget
    ? { TaskList: taskCreateTarget, TaskGet: taskCreateTarget }
    : {}

  /** Resolve a single tool token: source-specific → canonical → target-specific */
  function remap(tool: string): string {
    const canonical = reverseFrom[tool] ?? tool
    return toAliases[canonical] ?? conversionSupplement[canonical] ?? canonical
  }

  const unmappedSet = new Set<string>()

  // ── Rewrite frontmatter allowed-tools field ──────────────────────────────
  // Supports both inline and YAML-list forms.
  const remappedFrontmatter = remapAllowedToolsFrontmatter(content, remap)
  for (const u of remappedFrontmatter.unmapped) unmappedSet.add(u)
  let result = remappedFrontmatter.result

  result = rewriteBodyToolNames(result, fromAgent, conversionSupplement, allAgents, remap)
  return { content: result, unmapped: [...unmappedSet] }
}
