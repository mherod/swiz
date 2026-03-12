interface ParsedHookContext {
  source: string | null
  details: Array<{ label: string; value: string }>
  notes: string[]
}

export interface ParsedObjective {
  title: string
  bullets: string[]
}

export interface ParsedAttachedSkill {
  name: string
  path: string | null
}

export interface ParsedAttachedSkills {
  title: string
  skills: ParsedAttachedSkill[]
  notes: string[]
}

export interface ParsedUserMetadataBlock {
  title: string
  details: Array<{ label: string; value: string }>
  notes: string[]
  kind?: "gitAction" | "elementContext" | "slashCommand" | "tagged"
}

export interface UserMessageParts {
  visibleText: string
  hookContext: ParsedHookContext | null
  parsedObjective: ParsedObjective | null
  attachedSkills: ParsedAttachedSkills | null
  metadataBlocks: ParsedUserMetadataBlock[]
}

export interface AssistantMessageParts {
  visibleText: string
  thoughtText: string | null
}

function isMarkdownLike(text: string): boolean {
  return /(^|\n)\s*(#{1,6}\s|[-*]\s|>\s|```)|`[^`]+`|\[[^\]]+\]\([^)]+\)|\*\*[^*]+\*\*|#\d+\b/m.test(
    text
  )
}

export function normalizeAssistantText(text: string): string {
  if (isMarkdownLike(text)) return text
  if (text.length < 300) return text
  const newlineCount = (text.match(/\n/g) ?? []).length
  if (newlineCount > 8) return text
  return text
    .replace(/\. (?=[A-Z][a-z]{2,}\b)/g, ".\n\n")
    .replace(/\) (?=[A-Z][a-z]{2,}\b)/g, ")\n\n")
    .replace(/: (?=[A-Z][a-z]{2,}\b)/g, ":\n")
}

export function splitAssistantMessage(text: string): AssistantMessageParts {
  const thoughts: string[] = []
  const visibleText = stripRolePrefix(
    sanitizeInternalNoise(
      text
        .replace(/<thought>([\s\S]*?)(?:<\/thought>|$)/gi, (_, inner: string) => {
          const cleaned = inner.trim()
          if (cleaned) thoughts.push(cleaned)
          return ""
        })
        .replace(/\n{3,}/g, "\n\n")
        .trim()
    ),
    "assistant"
  )

  const thoughtText = thoughts.join("\n\n").trim()
  return {
    visibleText,
    thoughtText: thoughtText.length > 0 ? thoughtText : null,
  }
}

export function splitUserMessage(text: string): UserMessageParts {
  const {
    cleanedText,
    blockContent: attachedSkillsRaw,
    metadataBlocks: taggedMetadataBlocks,
  } = extractUserMetadataBlocks(text)
  const normalizedText = unwrapLeadingTag(cleanedText, "user_query")
  const { cleanedText: compactText, metadataBlocks: inlineMetadataBlocks } =
    extractInlineContextBlocks(normalizedText)
  const attachedSkills = parseManuallyAttachedSkills(attachedSkillsRaw)
  const metadataBlocks = [...taggedMetadataBlocks, ...inlineMetadataBlocks]

  const marker = "<hook_context>"
  const markerIndex = compactText.indexOf(marker)
  if (markerIndex < 0) {
    const visibleText = stripRolePrefix(sanitizeInternalNoise(compactText.trim()), "user")
    return {
      visibleText,
      hookContext: null,
      parsedObjective: parseObjective(visibleText),
      attachedSkills,
      metadataBlocks,
    }
  }

  const visibleText = stripRolePrefix(
    sanitizeInternalNoise(compactText.slice(0, markerIndex).trim()),
    "user"
  )
  const rawContext = compactText.slice(markerIndex + marker.length).trim()
  const hookContext = parseHookContext(rawContext)

  return {
    visibleText,
    hookContext,
    parsedObjective: parseObjective(visibleText),
    attachedSkills,
    metadataBlocks,
  }
}

function extractInlineContextBlocks(text: string): {
  cleanedText: string
  metadataBlocks: ParsedUserMetadataBlock[]
} {
  let cleanedText = text
  const metadataBlocks: ParsedUserMetadataBlock[] = []

  const slashCommand = extractLeadingSlashCommandBlock(cleanedText)
  cleanedText = slashCommand.cleanedText
  if (slashCommand.block) metadataBlocks.push(slashCommand.block)

  const uncommitted = extractUncommittedChangesBlock(cleanedText)
  cleanedText = uncommitted.cleanedText
  if (uncommitted.block) metadataBlocks.push(uncommitted.block)

  const codeSelections = extractCodeSelectionBlocks(cleanedText)
  cleanedText = codeSelections.cleanedText
  metadataBlocks.push(...codeSelections.blocks)

  const attachedFiles = extractAttachedFilesBlock(cleanedText)
  cleanedText = attachedFiles.cleanedText
  if (attachedFiles.block) metadataBlocks.push(attachedFiles.block)

  const inlineTagged = extractInlineTaggedMetadataBlocks(cleanedText)
  cleanedText = inlineTagged.cleanedText
  metadataBlocks.push(...inlineTagged.blocks)

  const domContext = extractDomInspectionBlocks(cleanedText)
  cleanedText = domContext.cleanedText
  metadataBlocks.push(...domContext.blocks)

  return { cleanedText, metadataBlocks }
}

const INLINE_METADATA_TAGS = [
  "user_query",
  "agent_skills",
  "agent_transcripts",
  "open_and_recently_viewed_files",
  "user_info",
  "git_status",
  "system_reminder",
] as const

const INLINE_NESTED_TAGS = new Set<string>(["agent_skills"])

function extractInlineTaggedMetadataBlocks(text: string): {
  cleanedText: string
  blocks: ParsedUserMetadataBlock[]
} {
  let cleanedText = text
  const blocks: ParsedUserMetadataBlock[] = []

  for (const tagName of INLINE_METADATA_TAGS) {
    const extracted = extractNamedInlineTagBlocks(cleanedText, tagName)
    cleanedText = extracted.cleanedText
    blocks.push(...extracted.blocks)
  }

  return { cleanedText, blocks }
}

function extractNamedInlineTagBlocks(
  text: string,
  tagName: string
): { cleanedText: string; blocks: ParsedUserMetadataBlock[] } {
  const escapedTag = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const allowsNested = INLINE_NESTED_TAGS.has(tagName)
  const pattern = allowsNested
    ? `<${escapedTag}>\\s*([\\s\\S]*?)(?:\\s*<\\/${escapedTag}>|$)`
    : `<${escapedTag}>\\s*([\\s\\S]*?)(?:\\s*<\\/${escapedTag}>|(?=<[a-z_]+(?:\\s|>))|$)`
  const tagRe = new RegExp(pattern, "gi")
  const blocks: ParsedUserMetadataBlock[] = []
  let cleanedText = text
  for (const match of text.matchAll(tagRe)) {
    const full = match[0]
    if (!full) continue
    const parsed = parseInlineTaggedMetadataBlock(tagName, (match[1] ?? "").trim())
    if (parsed) blocks.push(parsed)
    cleanedText = cleanedText.replace(full, "").trim()
  }

  return { cleanedText, blocks }
}

function parseInlineTaggedMetadataBlock(
  tagName: string,
  raw: string
): ParsedUserMetadataBlock | null {
  if (tagName === "user_query") return parseInlineUserQueryBlock(raw)
  if (tagName === "agent_skills") return parseAgentSkillsBlock(raw)
  return parseGenericMetadataBlock(tagName, raw)
}

function parseInlineUserQueryBlock(raw: string): ParsedUserMetadataBlock | null {
  const normalized = raw
    .replace(/```[\s\S]*?```/g, (block) => compactMetadataValue(block.replace(/\s+/g, " "), 180))
    .replace(/\s+/g, " ")
    .trim()
  if (!normalized) return null
  return {
    title: "Embedded user query",
    details: [],
    notes: [compactMetadataValue(normalized, 220)],
    kind: "tagged",
  }
}

function parseAgentSkillsBlock(raw: string): ParsedUserMetadataBlock | null {
  const skillRe = /<agent_skill\b([^>]*)>([\s\S]*?)<\/agent_skill>/gi
  const skills: Array<{ path: string | null; description: string }> = []
  for (const match of raw.matchAll(skillRe)) {
    const attrs = match[1] ?? ""
    const description = compactMetadataValue((match[2] ?? "").replace(/\s+/g, " ").trim(), 120)
    if (!description) continue
    const path = /fullPath="([^"]+)"/i.exec(attrs)?.[1]?.trim() ?? null
    skills.push({ path, description })
    if (skills.length >= 200) break
  }

  if (skills.length === 0) {
    const normalized = compactMetadataValue(raw.replace(/\s+/g, " ").trim(), 220)
    if (!normalized) return null
    return {
      title: "Agent skills",
      details: [],
      notes: [normalized],
      kind: "tagged",
    }
  }

  const details: Array<{ label: string; value: string }> = [
    { label: "count", value: `${skills.length}` },
  ]
  for (const skill of skills.slice(0, 6)) {
    const label = skill.path ? "skill" : "desc"
    const value = skill.path ? compactSkillPath(skill.path) : skill.description
    details.push({ label, value })
  }

  const notes: string[] = []
  if (skills.length > 6) notes.push(`${skills.length - 6} more skills`)
  return {
    title: "Agent skills",
    details,
    notes,
    kind: "tagged",
  }
}

function compactSkillPath(path: string): string {
  const parts = path.split("/").filter(Boolean)
  if (parts.length < 2) return compactMetadataValue(path, 120)
  const skillName = parts[parts.length - 2] ?? path
  return compactMetadataValue(skillName, 80)
}

function extractLeadingSlashCommandBlock(text: string): {
  cleanedText: string
  block: ParsedUserMetadataBlock | null
} {
  const match = /^\s*(\/[a-z0-9_-]+)\b/i.exec(text)
  const command = match?.[1]
  if (!command) return { cleanedText: text, block: null }

  const cleanedText = text.slice(match[0].length).trim()
  return {
    cleanedText,
    block: {
      title: "Slash command",
      details: [{ label: "name", value: command }],
      notes: [],
      kind: "slashCommand",
    },
  }
}

const GIT_ACTION_SIGNAL_RE =
  /Uncommitted changes detected:|ACTION REQUIRED:|Commit your changes:|Push your committed changes/i
const GIT_FIRST_LINE_RE =
  /Uncommitted changes detected:|modified \(\d+ file\(s\)\)|ACTION REQUIRED:/i
const FILE_PATH_RE = /\b([A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx|json|md|yml|yaml|sh|css|html))\b/g

function extractGitFilePaths(lines: string[], declaredCount: number | null): string[] {
  const filePathSet = new Set<string>()
  for (const line of lines) {
    for (const match of line.match(FILE_PATH_RE) ?? []) {
      if (match.includes("/")) filePathSet.add(match)
      if (filePathSet.size >= 6) break
    }
    if (filePathSet.size >= 6) break
  }
  const paths = [...filePathSet]
  return declaredCount && declaredCount > 0 ? paths.slice(0, declaredCount) : paths
}

function buildGitActionDetails(
  lines: string[],
  first: string | undefined
): { details: Array<{ label: string; value: string }>; notes: string[] } {
  const details: Array<{ label: string; value: string }> = []
  const notes: string[] = []

  if (first) {
    details.push({
      label: "changes",
      value: compactMetadataValue(
        first.replace(/^Uncommitted changes detected:\s*/i, "").replace(/^ACTION REQUIRED:\s*/i, "")
      ),
    })
  }

  const actionLine = lines.find((l) => l.startsWith("ACTION REQUIRED:"))
  if (actionLine) {
    notes.push(compactMetadataValue(actionLine.replace(/^ACTION REQUIRED:\s*/i, "").trim(), 180))
  }

  const commitCmd = lines.find((l) => /\bgit\s+commit\b/.test(l))
  if (commitCmd) details.push({ label: "commit", value: compactMetadataValue(commitCmd) })

  const pushCmd = lines.find((l) => /\bgit\s+push\b/.test(l))
  if (pushCmd) details.push({ label: "push", value: compactMetadataValue(pushCmd) })

  const declaredCount = first?.match(/(\d+)\s*file\(s\)/i)?.[1]
  const filePaths = extractGitFilePaths(
    lines,
    declaredCount ? Number.parseInt(declaredCount, 10) : null
  )
  for (const filePath of filePaths) details.push({ label: "file", value: filePath })

  return { details, notes }
}

function extractUncommittedChangesBlock(text: string): {
  cleanedText: string
  block: ParsedUserMetadataBlock | null
} {
  if (!GIT_ACTION_SIGNAL_RE.test(text)) return { cleanedText: text, block: null }

  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  if (lines.length === 0) return { cleanedText: text, block: null }

  const first = lines.find((l) => GIT_FIRST_LINE_RE.test(l))
  const { details, notes } = buildGitActionDetails(lines, first)

  return {
    cleanedText: "",
    block: { title: "Git action required", details, notes, kind: "gitAction" },
  }
}

function buildDomInspectionBlockFromMatch(
  match: RegExpMatchArray,
  index: number
): ParsedUserMetadataBlock | null {
  const domPathRaw = match[1] ?? ""
  const positionRaw = match[2] ?? ""
  const componentRaw = match[3] ?? ""
  const elementRaw = match[4] ?? ""

  const details: Array<{ label: string; value: string }> = []
  const domPath = compactMetadataValue(domPathRaw, 220)
  if (domPath) details.push({ label: "dom path", value: domPath })

  const position = compactMetadataValue(positionRaw, 180)
  if (position) details.push({ label: "position", value: position })

  const component = compactMetadataValue(componentRaw, 120)
  if (component) details.push({ label: "react component", value: component })

  const htmlElement = compactHtmlElementValue(elementRaw)
  if (htmlElement) details.push({ label: "html element", value: htmlElement })
  if (details.length === 0) return null

  return {
    title: index > 0 ? `Element context ${index + 1}` : "Element context",
    details,
    notes: [],
    kind: "elementContext",
  }
}

function stripRanges(text: string, ranges: Array<{ start: number; end: number }>): string {
  if (ranges.length === 0) return text
  let cleanedText = ""
  let cursor = 0
  for (const range of ranges) {
    cleanedText += text.slice(cursor, range.start)
    cursor = range.end
  }
  cleanedText += text.slice(cursor)
  return cleanedText.trim()
}

function extractDomInspectionBlocks(text: string): {
  cleanedText: string
  blocks: ParsedUserMetadataBlock[]
} {
  const entryRe =
    /DOM Path:\s*(.+?)\nPosition:\s*(.+?)\nReact Component:\s*(.+?)\nHTML Element:\s*(.+?)(?=(?:\nDOM Path:|\s*$))/gis
  const blocks: ParsedUserMetadataBlock[] = []
  const consumedRanges: Array<{ start: number; end: number }> = []
  for (const match of text.matchAll(entryRe)) {
    const start = match.index
    const raw = match[0]
    if (start == null || !raw) continue
    const block = buildDomInspectionBlockFromMatch(match, blocks.length)
    if (!block) continue
    blocks.push(block)
    consumedRanges.push({ start, end: start + raw.length })
  }

  if (blocks.length === 0) return { cleanedText: text, blocks: [] }
  return { cleanedText: stripRanges(text, consumedRanges), blocks }
}

function extractAttachedFilesBlock(text: string): {
  cleanedText: string
  block: ParsedUserMetadataBlock | null
} {
  const tagRe = /<attached_files>\s*([\s\S]*?)(?:<\/attached_files>|(?=<[a-z_]+(?:\s|>))|$)/i
  const match = tagRe.exec(text)
  if (!match) return { cleanedText: text, block: null }

  const raw = (match[1] ?? "").trim()
  const entries = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 6)
  if (entries.length === 0) {
    return { cleanedText: text.replace(match[0], "").trim(), block: null }
  }

  const details: Array<{ label: string; value: string }> = []
  for (const entry of entries)
    details.push({ label: "file", value: compactMetadataValue(entry, 180) })

  return {
    cleanedText: text.replace(match[0], "").trim(),
    block: {
      title: "Attached files",
      details,
      notes: [],
      kind: "tagged",
    },
  }
}

function parseCodeSelectionBlock(
  attrsRaw: string,
  codeRaw: string,
  index: number
): ParsedUserMetadataBlock | null {
  const path = /path="([^"]+)"/i.exec(attrsRaw)?.[1]?.trim() ?? null
  const lines = /lines="([^"]+)"/i.exec(attrsRaw)?.[1]?.trim() ?? null

  const details: Array<{ label: string; value: string }> = []
  if (path) details.push({ label: "path", value: compactPathValue(path) })
  if (lines) details.push({ label: "lines", value: lines })

  const notes: string[] = []
  const preview = compactCodeSelectionPreview(codeRaw)
  if (preview) notes.push(preview)

  if (details.length === 0 && notes.length === 0) return null
  return {
    title: index > 0 ? `Code selection ${index + 1}` : "Code selection",
    details,
    notes,
    kind: "tagged",
  }
}

function extractCodeSelectionBlocks(text: string): {
  cleanedText: string
  blocks: ParsedUserMetadataBlock[]
} {
  const blockRe = /<code_selection([^>]*)>([\s\S]*?)<\/code_selection>/gi
  const blocks: ParsedUserMetadataBlock[] = []
  let cleanedText = text

  for (const match of text.matchAll(blockRe)) {
    const full = match[0]
    if (!full) continue
    const block = parseCodeSelectionBlock(match[1] ?? "", (match[2] ?? "").trim(), blocks.length)
    if (block) blocks.push(block)
    cleanedText = cleanedText.replace(full, "").trim()
  }

  return { cleanedText, blocks }
}

function compactCodeSelectionPreview(value: string): string {
  if (!value) return ""
  const singleLine = value
    .replace(/^\s*\d+\|\s*/gm, "")
    .replace(/\s+/g, " ")
    .trim()
  return compactMetadataValue(singleLine, 180)
}

function compactPathValue(path: string): string {
  if (path.length <= 120) return path
  const keep = 55
  return `${path.slice(0, keep)}…${path.slice(-keep)}`
}

function compactMetadataValue(value: string, max = 120): string {
  const normalized = value.replace(/\s+/g, " ").trim()
  if (normalized.length <= max) return normalized
  return `${normalized.slice(0, max - 1).trimEnd()}…`
}

function compactHtmlElementValue(value: string): string {
  const normalized = compactMetadataValue(value, 180)
  const parsed = parseHtmlTagSignature(normalized)
  if (!parsed) return compactMetadataValue(normalized, 80)

  const selectors = [
    parsed.id ? `#${parsed.id}` : "",
    parsed.className ? `.${parsed.className}` : "",
  ].join("")
  const tag = parsed.tag.toLowerCase()
  return selectors ? `<${tag}${selectors}>` : `<${tag}>`
}

function parseHtmlTagSignature(
  value: string
): { tag: string; id: string | null; className: string | null } | null {
  const tagMatch = /<([a-z0-9-]+)\b([^>]*)>/i.exec(value)
  if (!tagMatch?.[1]) return null

  const attrs = tagMatch[2] ?? ""
  const classToken = /class\s*=\s*"([^"]+)"/i.exec(attrs)?.[1]?.trim().split(/\s+/)[0] ?? null
  const idToken = /id\s*=\s*"([^"]+)"/i.exec(attrs)?.[1]?.trim() ?? null
  return { tag: tagMatch[1], id: idToken, className: classToken }
}

function unwrapLeadingTag(text: string, tagName: string): string {
  const escapedTag = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const regex = new RegExp(`^\\s*<${escapedTag}>\\s*([\\s\\S]*?)\\s*<\\/${escapedTag}>\\s*`, "i")
  const match = regex.exec(text)
  if (!match?.[1]) return text
  const trailing = text.slice(match[0].length).trim()
  const inner = match[1].trim()
  return trailing ? `${inner}\n\n${trailing}` : inner
}

function extractLeadingTaggedBlock(
  text: string,
  tagName: string
): { cleanedText: string; blockContent: string | null } {
  const escapedTag = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const regex = new RegExp(`^\\s*<${escapedTag}>\\s*([\\s\\S]*?)(?:\\s*<\\/${escapedTag}>|$)`, "i")
  const match = regex.exec(text)
  if (!match) return { cleanedText: text, blockContent: null }

  const blockContent = match[1]?.trim() ?? null
  const cleanedText = text.slice(match[0].length).trim()
  return { cleanedText, blockContent }
}

function extractUserMetadataBlocks(text: string): {
  cleanedText: string
  blockContent: string | null
  metadataBlocks: ParsedUserMetadataBlock[]
} {
  let cleanedText = text
  let attachedSkillsRaw: string | null = null
  const metadataBlocks: ParsedUserMetadataBlock[] = []
  const metadataTags = [
    "user_info",
    "open_and_recently_viewed_files",
    "git_status",
    "system_reminder",
  ] as const

  const attached = extractLeadingTaggedBlock(cleanedText, "manually_attached_skills")
  cleanedText = attached.cleanedText
  attachedSkillsRaw = attached.blockContent

  for (const tagName of metadataTags) {
    const extracted = extractLeadingTaggedBlock(cleanedText, tagName)
    cleanedText = extracted.cleanedText
    if (!extracted.blockContent) continue
    const block = parseGenericMetadataBlock(tagName, extracted.blockContent)
    if (block) metadataBlocks.push(block)
  }

  return {
    cleanedText,
    blockContent: attachedSkillsRaw,
    metadataBlocks,
  }
}

function parseGenericMetadataBlock(tagName: string, raw: string): ParsedUserMetadataBlock | null {
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  if (lines.length === 0) return null

  const details: Array<{ label: string; value: string }> = []
  const notes: string[] = []
  for (const line of lines) {
    const kv = /^([^:]{1,40}):\s*(.+)$/.exec(line)
    if (kv?.[1] && kv[2]) {
      details.push({
        label: kv[1].trim().toLowerCase(),
        value: compactMetadataValue(kv[2].trim()),
      })
      continue
    }
    notes.push(line)
  }

  const visibleNotes = notes.slice(0, 4)
  if (notes.length > 4) {
    visibleNotes.push(`...${notes.length - 4} more lines`)
  }

  return {
    title: tagName.replace(/_/g, " "),
    details: details.slice(0, 6),
    notes: visibleNotes,
    kind: "tagged",
  }
}

function parseManuallyAttachedSkills(raw: string | null): ParsedAttachedSkills | null {
  if (!raw) return null
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  if (lines.length === 0) return null

  const skills: ParsedAttachedSkill[] = []
  let current: ParsedAttachedSkill | null = null

  for (const line of lines) {
    const nameMatch = /^Skill Name:\s*(.+)$/i.exec(line)
    if (nameMatch?.[1]) {
      if (current) skills.push(current)
      current = { name: nameMatch[1].trim(), path: null }
      continue
    }

    const pathMatch = /^Path:\s*(.+)$/i.exec(line)
    if (pathMatch?.[1]) {
      if (current) current.path = pathMatch[1].trim()
      continue
    }

    if (/^SKILL\.md content:/i.test(line)) continue
  }

  if (current) skills.push(current)
  if (skills.length === 0) return null

  return {
    title: `Attached skills${skills.length > 0 ? ` (${skills.length})` : ""}`,
    skills,
    notes: [],
  }
}

function parseHookContext(rawContext: string): ParsedHookContext | null {
  if (!rawContext) return null

  let source: string | null = null
  let remaining = rawContext
  const sourceMatch = /^\[([^\]]+)\]\s*/.exec(remaining)
  if (sourceMatch?.[1]) {
    source = sourceMatch[1]
    remaining = remaining.slice(sourceMatch[0].length).trim()
  }

  const details: Array<{ label: string; value: string }> = []
  const notes: string[] = []

  // Extract common key/value metadata from hook output.
  const branchMatch = /branch:\s*([^\s|]+)/i.exec(remaining)
  if (branchMatch?.[1]) {
    details.push({ label: "branch", value: branchMatch[1].trim() })
  }

  const dirtyMatch = /uncommitted files:\s*(\d+)/i.exec(remaining)
  if (dirtyMatch?.[1]) {
    details.push({ label: "uncommitted", value: dirtyMatch[1].trim() })
  }

  const priorTaskMatch = /Prior session.*?incomplete task\(s\)\./i.exec(remaining)
  if (priorTaskMatch?.[0]) {
    notes.push(priorTaskMatch[0].trim())
  }

  const recoveryCmdMatch = /If already done,\s*run:\s*([^\n]+)$/i.exec(remaining)
  if (recoveryCmdMatch?.[1]) {
    details.push({ label: "recovery", value: recoveryCmdMatch[1].trim() })
  }

  if (details.length === 0 && notes.length === 0) {
    notes.push(remaining)
  }

  return { source, details, notes }
}

function parseObjective(text: string): ParsedObjective | null {
  const normalized = text.replace(/\s+/g, " ").trim()
  if (!normalized) return null

  const hasObjectiveLead = /^your task is to\b/i.test(normalized)
  if (!hasObjectiveLead) return null

  const hasInvestigationPattern =
    /deep investigation of the codebase/i.test(normalized) &&
    /relevant files/i.test(normalized) &&
    /code locations/i.test(normalized) &&
    /architectural mental map/i.test(normalized)

  if (hasInvestigationPattern) {
    return {
      title: "Deep codebase investigation",
      bullets: [
        "Identify all relevant files and modules.",
        "Pinpoint exact code locations tied to the objective.",
        "Build an architecture mental map of how components connect.",
        "Summarize implementation insights that guide the solution.",
      ],
    }
  }

  const genericObjective = /^your task is to\s+(.+?)(?:[.?!]|$)/i.exec(normalized)?.[1]?.trim()
  if (!genericObjective) return null
  return {
    title: "Parsed objective",
    bullets: [genericObjective.charAt(0).toUpperCase() + genericObjective.slice(1)],
  }
}

function sanitizeInternalNoise(text: string): string {
  return text
    .replace(/(^|\n)\s*StructuredOutput\s*(?=\n|$)/gi, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

function stripRolePrefix(text: string, role: "user" | "assistant"): string {
  const prefix = role === "user" ? /^User:\s*/i : /^Assistant:\s*/i
  return text.replace(prefix, "").trim()
}

function tryParseJson(text: string): string | null {
  const candidate = text.trim()
  if (!(candidate.startsWith("{") || candidate.startsWith("["))) return null
  try {
    const parsed = JSON.parse(candidate) as unknown
    return JSON.stringify(parsed, null, 2)
  } catch {
    return null
  }
}

function normalizeInlineFencedCode(text: string): string {
  if (!text.includes("```")) return text
  const normalized = text.replace(
    /```([a-zA-Z0-9_-]*)\s*([\s\S]*?)```/g,
    (_match: string, lang: string, code: string) => `\n\`\`\`${lang}\n${code.trim()}\n\`\`\`\n`
  )
  return normalized.replace(/\n{3,}/g, "\n\n").trim()
}

export function formatAssistantJsonBlocks(text: string): string {
  if (!text) return text
  const withNormalizedFences = normalizeInlineFencedCode(text)
  if (withNormalizedFences.includes("```")) return withNormalizedFences

  const wholeJson = tryParseJson(withNormalizedFences)
  if (wholeJson) return `\`\`\`json\n${wholeJson}\n\`\`\``

  // Common case: prose prefix followed by a JSON payload (for example API errors).
  const firstBrace = withNormalizedFences.indexOf("{")
  const firstBracket = withNormalizedFences.indexOf("[")
  const startCandidates = [firstBrace, firstBracket].filter((idx) => idx >= 0)
  if (startCandidates.length === 0) return withNormalizedFences
  const start = Math.min(...startCandidates)

  const jsonLike = withNormalizedFences.slice(start).trim()
  const parsed = tryParseJson(jsonLike)
  if (!parsed) return withNormalizedFences

  const prefix = withNormalizedFences.slice(0, start).trimEnd()
  if (!prefix) return `\`\`\`json\n${parsed}\n\`\`\``
  return `${prefix}\n\n\`\`\`json\n${parsed}\n\`\`\``
}
