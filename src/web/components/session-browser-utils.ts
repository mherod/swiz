import type {
  GroupedSessionMessage,
  ParsedSearchToolParams,
  ParsedSkillPayload,
  ParsedStatusToken,
  ParsedSwizTaskCommand,
  ParsedToolCallDetail,
  ProjectStateLabel,
  SessionMessage,
  SessionPreview,
} from "./session-browser-types.ts"

export const COLLAPSE_LINE_THRESHOLD = 20
export const COLLAPSE_CHAR_THRESHOLD = 900
export const TOOL_RAW_JSON_COLLAPSE_THRESHOLD = 300

export function formatTime(ts: number): string {
  return new Date(ts).toLocaleString([], {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
}

export function formatRelativeTime(ts: number): string {
  const deltaMs = Date.now() - ts
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  if (deltaMs < minute) return "just now"
  if (deltaMs < hour) return `${Math.floor(deltaMs / minute)}m ago`
  if (deltaMs < day) return `${Math.floor(deltaMs / hour)}h ago`
  return `${Math.floor(deltaMs / day)}d ago`
}

export function shortSessionId(id: string): string {
  if (id.length <= 14) return id
  return `${id.slice(0, 8)}...${id.slice(-4)}`
}

export function extractProjectState(statusLine?: string): ProjectStateLabel | null {
  if (!statusLine) return null
  const match = statusLine.match(
    /\bstate:\s*(planning|developing|reviewing|addressing-feedback)\b/i
  )
  return (match?.[1]?.toLowerCase() as ProjectStateLabel | undefined) ?? null
}

export function formatProjectStateLabel(state: ProjectStateLabel): string {
  return state === "addressing-feedback" ? "addressing feedback" : state
}

export function parseProjectStatusLine(statusLine?: string): ParsedStatusToken[] {
  if (!statusLine) return []
  const parts = statusLine
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean)
  const parsed: ParsedStatusToken[] = parts.map((part): ParsedStatusToken => {
    const lower = part.toLowerCase()
    if (lower.startsWith("state:")) return { label: part.replace(/^state:\s*/i, ""), tone: "state" }
    if (lower.includes("fetch failed")) return { label: "fetch failed", tone: "error" }
    if (lower.includes("(stale)")) return { label: part, tone: "warn" }
    if (lower.includes("changes requested")) return { label: part, tone: "warn" }
    if (lower.includes("approved")) return { label: part, tone: "success" }
    if (/\b\d+\s+issues?\b/.test(lower) || /\b\d+\s+prs?\b/.test(lower)) {
      return { label: part, tone: "info" }
    }
    return { label: part, tone: "neutral" }
  })
  return parsed.filter((token) => {
    if (token.tone === "state") return false
    if (token.tone !== "neutral") return true
    // Drop dense git shorthand tokens like "± main ~10 ?1 $3".
    if (/[±~?$]/.test(token.label)) return false
    return token.label.length <= 32
  })
}

export function providerProcessPids(
  provider: string | undefined,
  activeAgentPidsByProvider: Record<string, number[]>
): number[] {
  const key = (provider ?? "unknown").toLowerCase()
  return activeAgentPidsByProvider[key] ?? []
}

export function formatProcessPidLabel(pids: number[]): string {
  if (pids.length <= 2) return pids.join(",")
  return `${pids.slice(0, 2).join(",")} +${pids.length - 2}`
}

function mergeOptionalTimestamp(a: number | undefined, b: number | undefined): number | undefined {
  if (typeof a === "number" && typeof b === "number") return Math.min(a, b)
  return a ?? b
}

function mergeOptionalMax(a: number | undefined, b: number | undefined): number | undefined {
  return Math.max(a ?? 0, b ?? 0) || undefined
}

export function mergeSessionPreview(
  base: SessionPreview,
  incoming: SessionPreview
): SessionPreview {
  return {
    ...base,
    provider: base.provider || incoming.provider,
    format: base.format || incoming.format,
    startedAt: mergeOptionalTimestamp(base.startedAt, incoming.startedAt),
    lastMessageAt: mergeOptionalMax(base.lastMessageAt, incoming.lastMessageAt),
    mtime: Math.max(base.mtime, incoming.mtime),
    dispatches: mergeOptionalMax(base.dispatches, incoming.dispatches),
    processAlive: base.processAlive || incoming.processAlive,
  }
}

export function dedupeSessionsById(sessions: SessionPreview[]): SessionPreview[] {
  const byId = new Map<string, SessionPreview>()
  for (const session of sessions) {
    const existing = byId.get(session.id)
    if (!existing) {
      byId.set(session.id, session)
      continue
    }
    byId.set(session.id, mergeSessionPreview(existing, session))
  }
  return [...byId.values()]
}

export function buildCollapseHint(text: string): string {
  const lineCount = text.split("\n").length
  const charCount = text.length
  const charLabel = charCount >= 1000 ? `${(charCount / 1000).toFixed(1)}k` : `${charCount}`
  return `Expand · ${lineCount} lines · ${charLabel} chars`
}

export function summarizeText(text: string): string {
  if (text.length <= COLLAPSE_CHAR_THRESHOLD) return text
  const candidate = text.slice(0, COLLAPSE_CHAR_THRESHOLD)
  const cutIndex = Math.max(candidate.lastIndexOf(" "), candidate.lastIndexOf("\n"))
  return `${candidate.slice(0, cutIndex > 0 ? cutIndex : candidate.length).trimEnd()}…`
}

export function summarizeRawJson(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const compact = text.replace(/\s+/g, " ").trim()
  if (compact.length <= maxChars) return compact
  return `${compact.slice(0, maxChars - 1).trimEnd()}…`
}

export function looksLikeLogBlob(text: string): boolean {
  const hasErrorWords = /(error|exception|stack|trace|invalid|failed)/i.test(text)
  const hasSignatureNoise = /[{}[\]():;]/.test(text)
  const lines = text.split("\n").length
  return hasErrorWords && hasSignatureNoise && (lines > 8 || text.length > 420)
}

function canonicalGroupKey(message: SessionMessage): string {
  if (message.role !== "assistant") return `${message.role}|${message.text}`
  const normalized = message.text
    .replace(/after\s+\d+h\d+m\d+s\.?/gi, "after <duration>")
    .replace(/\b\d+m\d+s\b/gi, "<duration>")
    .replace(/\s+/g, " ")
    .trim()
  return `${message.role}|${normalized}`
}

export function groupMessages(messages: SessionMessage[]): GroupedSessionMessage[] {
  const grouped: GroupedSessionMessage[] = []
  for (let i = 0; i < messages.length; i++) {
    const current = messages[i]!
    const last = grouped[grouped.length - 1]
    if (last && canonicalGroupKey(last.message) === canonicalGroupKey(current)) {
      last.count += 1
      last.originalIndices.push(i)
      continue
    }
    grouped.push({
      message: current,
      count: 1,
      originalIndices: [i],
    })
  }
  return grouped
}

export function compactPath(path: string, maxLength = 56): string {
  if (path.length <= maxLength) return path
  const keep = Math.max(10, Math.floor((maxLength - 1) / 2))
  return `${path.slice(0, keep)}…${path.slice(-keep)}`
}

export function toToolFieldValue(value: unknown): string | null {
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (value === null) return "null"
  try {
    return JSON.stringify(value)
  } catch {
    return null
  }
}

export function parseToolCallDetail(name: string, detail: string): ParsedToolCallDetail {
  const trimmed = detail.trim()
  if (!trimmed) {
    return { command: null, description: null, commonFields: [], rawJson: null }
  }
  const parsed = (() => {
    try {
      return JSON.parse(trimmed) as unknown
    } catch {
      return null
    }
  })()
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      command: name.toLowerCase() === "bash" ? trimmed : null,
      description: null,
      commonFields: [],
      rawJson: null,
    }
  }

  const payload = parsed as Record<string, unknown>
  const command = typeof payload.command === "string" ? payload.command : null
  const description = typeof payload.description === "string" ? payload.description : null
  const fieldMap = [
    { key: "task_id", label: "task id" },
    { key: "tool_use_id", label: "tool use id" },
    { key: "timeout", label: "timeout" },
    { key: "block", label: "block" },
    { key: "cwd", label: "cwd" },
    { key: "working_directory", label: "working dir" },
    { key: "path", label: "path" },
    { key: "sessionId", label: "session" },
    { key: "pid", label: "pid" },
    { key: "limit", label: "limit" },
  ] as const
  const commonFields: Array<{ label: string; value: string }> = []
  for (const field of fieldMap) {
    const value = toToolFieldValue(payload[field.key])
    if (value) commonFields.push({ label: field.label, value })
  }
  return {
    command,
    description,
    commonFields,
    rawJson: JSON.stringify(payload, null, 2),
  }
}

function matchQuotedOrBareFlag(normalized: string, flag: string): string | null {
  return (
    new RegExp(`--${flag}\\s+"([^"]+)"`, "i").exec(normalized)?.[1] ??
    new RegExp(`--${flag}\\s+'([^']+)'`, "i").exec(normalized)?.[1] ??
    new RegExp(`--${flag}\\s+([^\\s]+)`, "i").exec(normalized)?.[1] ??
    null
  )
}

export function parseSwizTasksCommand(command: string): ParsedSwizTaskCommand | null {
  const normalized = command.replace(/\s+/g, " ").trim()
  const actionMatch =
    /(?:^| )(?:swiz|bun run index\.ts) tasks (complete|update|create|get|list)\b/i.exec(normalized)
  const action = actionMatch?.[1]?.toLowerCase()
  if (!action) return null

  const taskIdMatch = / tasks (?:complete|update|get)\s+([^\s-][^\s]*)/i.exec(normalized)
  const statusMatch = /--status\s+([^\s]+)/i.exec(normalized)

  return {
    action,
    taskId: taskIdMatch?.[1] ?? null,
    status: statusMatch?.[1] ?? null,
    subject: matchQuotedOrBareFlag(normalized, "subject"),
    evidence: matchQuotedOrBareFlag(normalized, "evidence"),
  }
}

export function parseSkillToolCallName(detail: string): string | null {
  const trimmed = detail.trim()
  if (!trimmed) return null
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>
    return typeof parsed.skill === "string" && parsed.skill.trim().length > 0
      ? parsed.skill.trim()
      : null
  } catch {
    return null
  }
}

export function skillNameFromMessage(message: SessionMessage | undefined): string | null {
  if (!message?.toolCalls || message.role !== "assistant") return null
  for (const tc of message.toolCalls) {
    if (tc.name.toLowerCase() !== "skill") continue
    const skillName = parseSkillToolCallName(tc.detail)
    if (skillName) return skillName
  }
  return null
}

export function parseSkillPayload(text: string): ParsedSkillPayload | null {
  if (!/Base directory for this skill:/i.test(text)) return null
  const lines = text.split("\n")
  const firstLine = lines[0]?.trim() ?? ""
  const baseDirMatch = /^Base directory for this skill:\s*(.+)$/i.exec(firstLine)
  const baseDir = baseDirMatch?.[1]?.trim() ?? null
  const body = (baseDirMatch ? lines.slice(1).join("\n") : text).trim()
  return { baseDir, body: body || text.trim() }
}

export function parseJsonObject(detail: string): Record<string, unknown> | null {
  const trimmed = detail.trim()
  if (!trimmed) return null
  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

export function parseSearchToolParams(name: string, detail: string): ParsedSearchToolParams | null {
  const lower = name.toLowerCase()
  if (lower !== "grep" && lower !== "rg") return null
  const payload = parseJsonObject(detail)
  if (!payload) return null

  const pattern = typeof payload.pattern === "string" ? payload.pattern : null
  const path = typeof payload.path === "string" ? payload.path : null
  const outputMode = typeof payload.output_mode === "string" ? payload.output_mode : null
  const optionKeys = [
    "context",
    "head_limit",
    "offset",
    "glob",
    "type",
    "multiline",
    "-A",
    "-B",
    "-C",
    "-i",
  ] as const
  const options: Array<{ label: string; value: string }> = []
  for (const key of optionKeys) {
    const value = toToolFieldValue(payload[key])
    if (value) options.push({ label: key, value })
  }
  return { pattern, path, outputMode, options }
}

export function isInternalToolName(name: string): boolean {
  return name.trim().toLowerCase() === "structuredoutput"
}
