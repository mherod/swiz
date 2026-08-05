import { parseQuotedString, transformQuotedString } from "./quoted-string.ts"

// ─── Conversion result type ──────────────────────────────────────────────────

export interface ConversionResult {
  content: string
  /** Tool names that exist in the source but have no mapping in the target */
  unmapped: string[]
}

// ─── Tool name remapping ─────────────────────────────────────────────────────

// Tool tokens may carry a permission specifier, e.g. `Bash(git add:*)`.
// The base name is remapped; the specifier is preserved verbatim.
const TOOL_SPECIFIER_RE = /^([A-Za-z][\w-]*)\((.*)\)$/

function splitToolSpecifier(tool: string): { base: string; specifier: string | null } {
  const match = tool.match(TOOL_SPECIFIER_RE)
  if (!match) return { base: tool, specifier: null }
  return { base: match[1]!, specifier: match[2]! }
}

/**
 * Build a reverse alias map: agent-specific tool name → canonical (Claude) name.
 * Claude's toolAliases is `{}`, so for Claude as source the reverse map is empty
 * (agent name == canonical name already).
 */
export function buildReverseMap(
  toolAliases: Record<string, string>,
  taskToolAliases?: Record<string, string | null>
): Record<string, string> {
  const rev: Record<string, string> = {}
  for (const [canonical, agentSpecific] of Object.entries(toolAliases)) {
    rev[agentSpecific] = canonical
  }
  if (taskToolAliases) {
    for (const [canonical, agentSpecific] of Object.entries(taskToolAliases)) {
      if (agentSpecific) {
        rev[agentSpecific] = canonical
      }
    }
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
  remap: (tool: string) => string,
  isAvailable?: (tool: string) => boolean
): { result: string; unmapped: string[] } {
  const unmapped: string[] = []
  const filtered: string[] = []
  for (const raw of list.split(",")) {
    if (!raw.trim()) continue
    const { token, unmapped: u } = remapToken(raw, remap)
    const available = !isAvailable || isAvailable(token)
    if (u && !available) unmapped.push(u)
    if (available) {
      filtered.push(token)
    }
  }
  return { result: filtered.join(", "), unmapped }
}

function remapAllowedToolsBlock(
  frontmatterLines: string[],
  startIndex: number,
  remap: (tool: string) => string,
  isAvailable?: (tool: string) => boolean
): { lines: string[]; nextIndex: number; unmapped: string[] } {
  const lines: string[] = []
  const unmapped: string[] = []
  let index = startIndex

  while (index < frontmatterLines.length) {
    const listLine = frontmatterLines[index]!
    const itemMatch = listLine.match(/^(\s*-\s*)(.+)$/)
    if (!itemMatch) break

    const { mappedRaw, unmapped: unmatchedTool } = remapPossiblyQuotedTool(itemMatch[2]!, remap)
    const available = !isAvailable || isAvailable(mappedRaw)
    if (unmatchedTool && !available) unmapped.push(unmatchedTool)
    if (available) {
      lines.push(`${itemMatch[1]}${mappedRaw}`)
    }
    index++
  }

  return { lines, nextIndex: index, unmapped }
}

export function remapAllowedToolsFrontmatter(
  content: string,
  remap: (tool: string) => string,
  isAvailable?: (tool: string) => boolean
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
      const { result: remapped, unmapped: inlineUnmapped } = remapToolList(
        inlineMatch[2]!,
        remap,
        isAvailable
      )
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
    const blockResult = remapAllowedToolsBlock(frontmatterLines, i + 1, remap, isAvailable)
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
  fromAgent: {
    toolAliases: Record<string, string>
    taskToolAliases?: Record<string, string | null>
  },
  supplement: Record<string, string>,
  allAgents: {
    toolAliases: Record<string, string>
    taskToolAliases?: Record<string, string | null>
  }[]
): Set<string> {
  const names = new Set<string>([
    ...Object.keys(fromAgent.toolAliases),
    ...Object.values(fromAgent.toolAliases),
  ])
  if (fromAgent.taskToolAliases) {
    for (const [canonical, agentSpecific] of Object.entries(fromAgent.taskToolAliases)) {
      names.add(canonical)
      if (agentSpecific) names.add(agentSpecific)
    }
  }
  for (const agent of allAgents) {
    for (const canonical of Object.keys(agent.toolAliases)) names.add(canonical)
    if (agent.taskToolAliases) {
      for (const canonical of Object.keys(agent.taskToolAliases)) names.add(canonical)
    }
  }
  for (const canonical of Object.keys(supplement)) names.add(canonical)
  return names
}

function rewriteBodyToolNames(
  text: string,
  fromAgent: {
    toolAliases: Record<string, string>
    taskToolAliases?: Record<string, string | null>
  },
  supplement: Record<string, string>,
  allAgents: {
    toolAliases: Record<string, string>
    taskToolAliases?: Record<string, string | null>
  }[],
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

function addAvailableToolNames(
  tools: Set<string>,
  names: Iterable<string | null | undefined>
): void {
  for (const name of names) {
    if (name) tools.add(name)
  }
}

// ─── Public: convert skill content between agents ────────────────────────────

export function convertSkillContent(
  content: string,
  fromAgent: {
    id: string
    toolAliases: Record<string, string>
    taskToolAliases?: Record<string, string | null>
  },
  toAgent: {
    id: string
    toolAliases: Record<string, string>
    taskToolAliases?: Record<string, string | null>
    additionalToolNames?: readonly string[]
  },
  allAgents: {
    toolAliases: Record<string, string>
    taskToolAliases?: Record<string, string | null>
  }[]
): ConversionResult {
  if (fromAgent.id === toAgent.id) return { content, unmapped: [] }

  const reverseFrom = buildReverseMap(fromAgent.toolAliases, fromAgent.taskToolAliases)
  const toAliases = toAgent.toolAliases
  const toTaskAliases = toAgent.taskToolAliases

  // Conversion-only supplement: read-only task tools (TaskList, TaskGet) are
  // intentionally absent from toolAliases (they must pass through in hook
  // contexts) but should be remapped during skill conversion to the same
  // target as TaskCreate, if one exists.
  const taskCreateTarget = toAliases.TaskCreate ?? toTaskAliases?.TaskCreate ?? undefined
  const conversionSupplement: Record<string, string> = {}
  if (taskCreateTarget) {
    conversionSupplement.TaskList = taskCreateTarget
    conversionSupplement.TaskGet = taskCreateTarget
  }

  function buildTargetAgentAvailableTools(
    toAgent: {
      id: string
      toolAliases: Record<string, string>
      taskToolAliases?: Record<string, string | null>
      additionalToolNames?: readonly string[]
    },
    taskCreateTarget?: string
  ): Set<string> {
    const tools = new Set<string>()
    if (toAgent.id === "claude") {
      const CLAUDE_EMITTED_TOOL_NAMES = [
        "Bash",
        "Edit",
        "Write",
        "Read",
        "Grep",
        "Glob",
        "Task",
        "TaskCreate",
        "TaskUpdate",
        "TaskList",
        "TaskGet",
        "NotebookEdit",
        "Skill",
      ]
      for (const t of CLAUDE_EMITTED_TOOL_NAMES) {
        tools.add(t)
      }
    } else {
      addAvailableToolNames(tools, Object.values(toAgent.toolAliases))
      addAvailableToolNames(tools, Object.values(toAgent.taskToolAliases ?? {}))
      if (taskCreateTarget) {
        tools.add(taskCreateTarget)
      }
      addAvailableToolNames(tools, toAgent.additionalToolNames ?? [])
      if ((toAgent as any).tasksEnabled) {
        tools.add("TaskList")
        tools.add("TaskGet")
      }
    }
    return tools
  }

  const toAgentAvailableTools = buildTargetAgentAvailableTools(toAgent, taskCreateTarget)

  const isAvailable = (tool: string): boolean => {
    const cleanTool = tool.replace(/^["']|["']$/g, "").trim()
    const { base } = splitToolSpecifier(cleanTool)
    return toAgentAvailableTools.has(base)
  }

  /** Resolve a single tool name: source-specific → canonical → target-specific */
  function remapName(tool: string): string {
    const canonical = reverseFrom[tool] ?? tool
    if (toTaskAliases && toTaskAliases[canonical] === null) {
      return canonical
    }
    const mapped =
      toAliases[canonical] ??
      toTaskAliases?.[canonical] ??
      conversionSupplement[canonical] ??
      canonical
    return mapped !== null ? mapped : canonical
  }

  /** Remap a tool token, handling `Tool(specifier)` forms like `Bash(git add:*)`. */
  function remap(tool: string): string {
    const { base, specifier } = splitToolSpecifier(tool)
    if (specifier === null) return remapName(tool)
    return `${remapName(base)}(${specifier})`
  }

  const unmappedSet = new Set<string>()

  // ── Rewrite frontmatter allowed-tools field ──────────────────────────────
  // Supports both inline and YAML-list forms.
  const remappedFrontmatter = remapAllowedToolsFrontmatter(content, remap, isAvailable)
  // Report base names for specifier tokens: `ImaginaryTool(x)` → `ImaginaryTool`.
  for (const u of remappedFrontmatter.unmapped) unmappedSet.add(splitToolSpecifier(u).base)
  let result = remappedFrontmatter.result

  result = rewriteBodyToolNames(result, fromAgent, conversionSupplement, allAgents, remap)
  return { content: result, unmapped: [...unmappedSet] }
}
