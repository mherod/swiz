import { type ReactNode, useMemo, useState } from "react"
import { cn } from "../lib/cn.ts"
import type { EventMetric } from "../lib/dashboard-helpers.ts"
import type { ActiveHookDispatch } from "../lib/dashboard-hooks.ts"
import {
  formatAssistantJsonBlocks,
  normalizeAssistantText,
  splitAssistantMessage,
  splitUserMessage,
} from "../lib/message-format.ts"
import { DashboardStats } from "./dashboard-stats.tsx"
import { Markdown, renderInline } from "./markdown.tsx"

export interface SessionPreview {
  id: string
  provider?: string
  format?: string
  mtime: number
  startedAt?: number
  lastMessageAt?: number
  dispatches?: number
  activeDispatch?: ActiveHookDispatch
  /** True when a verified agent process is running for this session's provider and project. */
  processAlive?: boolean
}

export interface ProjectSessions {
  cwd: string
  name: string
  lastSeenAt: number
  sessionCount: number
  sessions: SessionPreview[]
  statusLine?: string
}

export interface ToolCallSummary {
  name: string
  detail: string
}

export interface SessionMessage {
  role: "user" | "assistant"
  timestamp: string | null
  text: string
  toolCalls?: ToolCallSummary[]
}

export interface SessionTask {
  id: string
  subject: string
  status: "pending" | "in_progress" | "completed" | "cancelled"
  statusChangedAt: string | null
  completionTimestamp: string | null
  completionEvidence: string | null
}

export interface SessionTaskSummary {
  total: number
  open: number
  completed: number
  cancelled: number
}

export interface ProjectTask extends SessionTask {
  sessionId: string
}

interface GroupedSessionMessage {
  message: SessionMessage
  count: number
  originalIndices: number[]
}

interface ParsedToolCallDetail {
  command: string | null
  description: string | null
  commonFields: Array<{ label: string; value: string }>
  rawJson: string | null
}

interface ParsedSwizTaskCommand {
  action: string
  taskId: string | null
  status: string | null
  subject: string | null
  evidence: string | null
}

interface ParsedSkillPayload {
  baseDir: string | null
  body: string
}

interface ParsedSearchToolParams {
  pattern: string | null
  path: string | null
  outputMode: string | null
  options: Array<{ label: string; value: string }>
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString([], {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
}

function formatRelativeTime(ts: number): string {
  const deltaMs = Date.now() - ts
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  if (deltaMs < minute) return "just now"
  if (deltaMs < hour) return `${Math.floor(deltaMs / minute)}m ago`
  if (deltaMs < day) return `${Math.floor(deltaMs / hour)}h ago`
  return `${Math.floor(deltaMs / day)}d ago`
}

function shortSessionId(id: string): string {
  if (id.length <= 14) return id
  return `${id.slice(0, 8)}...${id.slice(-4)}`
}

type ProjectStateLabel = "planning" | "developing" | "reviewing" | "addressing-feedback"

function extractProjectState(statusLine?: string): ProjectStateLabel | null {
  if (!statusLine) return null
  const match = statusLine.match(
    /\bstate:\s*(planning|developing|reviewing|addressing-feedback)\b/i
  )
  return (match?.[1]?.toLowerCase() as ProjectStateLabel | undefined) ?? null
}

function formatProjectStateLabel(state: ProjectStateLabel): string {
  return state === "addressing-feedback" ? "addressing feedback" : state
}

type StatusChipTone = "neutral" | "info" | "warn" | "success" | "state"

interface ParsedStatusToken {
  label: string
  tone: StatusChipTone
}

function parseProjectStatusLine(statusLine?: string): ParsedStatusToken[] {
  if (!statusLine) return []
  const parts = statusLine
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean)
  const parsed: ParsedStatusToken[] = parts.map((part): ParsedStatusToken => {
    const lower = part.toLowerCase()
    if (lower.startsWith("state:")) return { label: part.replace(/^state:\s*/i, ""), tone: "state" }
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

function providerProcessPids(
  provider: string | undefined,
  activeAgentPidsByProvider: Record<string, number[]>
): number[] {
  const key = (provider ?? "unknown").toLowerCase()
  return activeAgentPidsByProvider[key] ?? []
}

function formatProcessPidLabel(pids: number[]): string {
  if (pids.length <= 2) return pids.join(",")
  return `${pids.slice(0, 2).join(",")} +${pids.length - 2}`
}

function mergeSessionPreview(base: SessionPreview, incoming: SessionPreview): SessionPreview {
  return {
    ...base,
    provider: base.provider || incoming.provider,
    format: base.format || incoming.format,
    startedAt:
      typeof base.startedAt === "number" && typeof incoming.startedAt === "number"
        ? Math.min(base.startedAt, incoming.startedAt)
        : (base.startedAt ?? incoming.startedAt),
    lastMessageAt: Math.max(base.lastMessageAt ?? 0, incoming.lastMessageAt ?? 0) || undefined,
    mtime: Math.max(base.mtime, incoming.mtime),
    dispatches: Math.max(base.dispatches ?? 0, incoming.dispatches ?? 0) || undefined,
    processAlive: base.processAlive || incoming.processAlive,
  }
}

function dedupeSessionsById(sessions: SessionPreview[]): SessionPreview[] {
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

const COLLAPSE_LINE_THRESHOLD = 20
const COLLAPSE_CHAR_THRESHOLD = 900
const TOOL_RAW_JSON_COLLAPSE_THRESHOLD = 300

function buildCollapseHint(text: string): string {
  const lineCount = text.split("\n").length
  const charCount = text.length
  const charLabel = charCount >= 1000 ? `${(charCount / 1000).toFixed(1)}k` : `${charCount}`
  return `Expand · ${lineCount} lines · ${charLabel} chars`
}

function summarizeText(text: string): string {
  if (text.length <= COLLAPSE_CHAR_THRESHOLD) return text
  const candidate = text.slice(0, COLLAPSE_CHAR_THRESHOLD)
  const cutIndex = Math.max(candidate.lastIndexOf(" "), candidate.lastIndexOf("\n"))
  return `${candidate.slice(0, cutIndex > 0 ? cutIndex : candidate.length).trimEnd()}…`
}

function summarizeRawJson(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const compact = text.replace(/\s+/g, " ").trim()
  if (compact.length <= maxChars) return compact
  return `${compact.slice(0, maxChars - 1).trimEnd()}…`
}

function looksLikeLogBlob(text: string): boolean {
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

function groupMessages(messages: SessionMessage[]): GroupedSessionMessage[] {
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

function compactPath(path: string, maxLength = 56): string {
  if (path.length <= maxLength) return path
  const keep = Math.max(10, Math.floor((maxLength - 1) / 2))
  return `${path.slice(0, keep)}…${path.slice(-keep)}`
}

function toToolFieldValue(value: unknown): string | null {
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (value === null) return "null"
  try {
    return JSON.stringify(value)
  } catch {
    return null
  }
}

function parseToolCallDetail(name: string, detail: string): ParsedToolCallDetail {
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

function parseSwizTasksCommand(command: string): ParsedSwizTaskCommand | null {
  const normalized = command.replace(/\s+/g, " ").trim()
  const actionMatch =
    /(?:^| )(?:swiz|bun run index\.ts) tasks (complete|update|create|get|list)\b/i.exec(normalized)
  const action = actionMatch?.[1]?.toLowerCase()
  if (!action) return null

  const taskIdMatch = / tasks (?:complete|update|get)\s+([^\s-][^\s]*)/i.exec(normalized)
  const statusMatch = /--status\s+([^\s]+)/i.exec(normalized)
  const evidenceMatch =
    /--evidence\s+"([^"]+)"/i.exec(normalized) ??
    /--evidence\s+'([^']+)'/i.exec(normalized) ??
    /--evidence\s+([^\s]+)/i.exec(normalized)
  const subjectMatch =
    /--subject\s+"([^"]+)"/i.exec(normalized) ??
    /--subject\s+'([^']+)'/i.exec(normalized) ??
    /--subject\s+([^\s]+)/i.exec(normalized)

  return {
    action,
    taskId: taskIdMatch?.[1] ?? null,
    status: statusMatch?.[1] ?? null,
    subject: subjectMatch?.[1] ?? null,
    evidence: evidenceMatch?.[1] ?? null,
  }
}

function parseSkillToolCallName(detail: string): string | null {
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

function skillNameFromMessage(message: SessionMessage | undefined): string | null {
  if (!message?.toolCalls || message.role !== "assistant") return null
  for (const tc of message.toolCalls) {
    if (tc.name.toLowerCase() !== "skill") continue
    const skillName = parseSkillToolCallName(tc.detail)
    if (skillName) return skillName
  }
  return null
}

function parseSkillPayload(text: string): ParsedSkillPayload | null {
  if (!/Base directory for this skill:/i.test(text)) return null
  const lines = text.split("\n")
  const firstLine = lines[0]?.trim() ?? ""
  const baseDirMatch = /^Base directory for this skill:\s*(.+)$/i.exec(firstLine)
  const baseDir = baseDirMatch?.[1]?.trim() ?? null
  const body = (baseDirMatch ? lines.slice(1).join("\n") : text).trim()
  return { baseDir, body: body || text.trim() }
}

function parseJsonObject(detail: string): Record<string, unknown> | null {
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

function parseSearchToolParams(name: string, detail: string): ParsedSearchToolParams | null {
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

function renderUserContextBlocks(
  parsedObjective: ReturnType<typeof splitUserMessage>["parsedObjective"] | undefined,
  hookContext: ReturnType<typeof splitUserMessage>["hookContext"] | undefined,
  attachedSkills: ReturnType<typeof splitUserMessage>["attachedSkills"] | undefined,
  metadataBlocks: ReturnType<typeof splitUserMessage>["metadataBlocks"] | undefined
): ReactNode {
  const blocks = metadataBlocks ?? []
  const hasContext =
    Boolean(parsedObjective) || Boolean(hookContext) || Boolean(attachedSkills) || blocks.length > 0
  const shouldUnwrapSinglePriorityBlock =
    !parsedObjective &&
    !hookContext &&
    !attachedSkills &&
    blocks.length === 1 &&
    blocks[0]?.kind === "gitAction"
  return (
    <>
      {parsedObjective ? (
        <div className="hook-context-box">
          <p className="hook-context-title">{parsedObjective.title}</p>
          <ul className="hook-context-list">
            {parsedObjective.bullets.map((bullet) => (
              <li key={bullet} className="hook-context-item">
                <span className="hook-context-label">goal</span>
                <span className="hook-context-note">{bullet}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {hookContext ? (
        <div className="hook-context-box">
          <p className="hook-context-title">
            Hook context{hookContext.source ? ` (${hookContext.source})` : ""}
          </p>
          {hookContext.details.length > 0 ? (
            <ul className="hook-context-list">
              {hookContext.details.map((item) => (
                <li key={`${item.label}:${item.value}`} className="hook-context-item">
                  <span className="hook-context-label">{item.label}</span>
                  <code className="hook-context-value">{item.value}</code>
                </li>
              ))}
            </ul>
          ) : null}
          {hookContext.notes.map((note) => (
            <p key={note} className="hook-context-note">
              {note}
            </p>
          ))}
        </div>
      ) : null}
      {attachedSkills ? (
        <details className="hook-context-box hook-context-collapsible">
          <summary className="hook-context-summary">{attachedSkills.title}</summary>
          {attachedSkills.skills.length > 0 ? (
            <ul className="hook-context-list">
              {attachedSkills.skills.map((skill) => (
                <li key={`${skill.name}:${skill.path ?? ""}`} className="hook-context-item">
                  <span className="hook-context-label">{skill.name}</span>
                  {skill.path ? (
                    <code className="hook-context-value" title={skill.path}>
                      {compactPath(skill.path)}
                    </code>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
          {attachedSkills.notes.map((note) => (
            <p key={note} className="hook-context-note">
              {note}
            </p>
          ))}
        </details>
      ) : null}
      {blocks.map((block, idx) =>
        shouldUnwrapSinglePriorityBlock ? (
          <div
            key={`${block.title}-${idx}`}
            className={cn(
              "hook-context-box",
              block.kind === "gitAction" ? "hook-context-priority" : null,
              block.kind === "elementContext" ? "hook-context-technical" : null,
              block.kind === "localCommandCaveat" ? "hook-context-caveat" : null,
              block.kind === "localCommand" ? "hook-context-local-command" : null
            )}
          >
            {block.kind === "localCommandCaveat" ? (
              <div className="local-command-caveat-header">
                <span className="caveat-icon">ⓘ</span>
                <p className="hook-context-title">{block.title}</p>
              </div>
            ) : block.kind === "localCommand" ? (
              <div className="local-command-header">
                <span className="terminal-icon">›_</span>
                <p className="hook-context-title">{block.title}</p>
              </div>
            ) : (
              <p className="hook-context-title">{block.title}</p>
            )}
            {block.details.length > 0 ? (
              <ul className="hook-context-list">
                {block.details.map((item) => (
                  <li key={`${item.label}:${item.value}`} className="hook-context-item">
                    <span className="hook-context-label">{item.label}</span>
                    <code
                      className={cn(
                        "hook-context-value",
                        block.kind === "localCommand" && item.label === "output" && "command-output"
                      )}
                    >
                      {item.value}
                    </code>
                  </li>
                ))}
              </ul>
            ) : null}
            {block.notes.map((note) => (
              <p key={`${block.title}:${note}`} className="hook-context-note">
                {note}
              </p>
            ))}
          </div>
        ) : (
          <details
            key={`${block.title}-${idx}`}
            className={cn(
              "hook-context-box hook-context-collapsible",
              block.kind === "gitAction" ? "hook-context-priority" : null,
              block.kind === "elementContext" ? "hook-context-technical" : null,
              block.kind === "localCommandCaveat" ? "hook-context-caveat" : null,
              block.kind === "localCommand" ? "hook-context-local-command" : null
            )}
          >
            <summary className="hook-context-summary">
              {block.kind === "localCommandCaveat" && <span className="caveat-icon">ⓘ </span>}
              {block.kind === "localCommand" && <span className="terminal-icon">›_ </span>}
              {block.title}
            </summary>
            {block.details.length > 0 ? (
              <ul className="hook-context-list">
                {block.details.map((item) => (
                  <li key={`${item.label}:${item.value}`} className="hook-context-item">
                    <span className="hook-context-label">{item.label}</span>
                    <code
                      className={cn(
                        "hook-context-value",
                        block.kind === "localCommand" && item.label === "output" && "command-output"
                      )}
                    >
                      {item.value}
                    </code>
                  </li>
                ))}
              </ul>
            ) : null}
            {block.notes.map((note) => (
              <p key={`${block.title}:${note}`} className="hook-context-note">
                {note}
              </p>
            ))}
          </details>
        )
      )}
      {hasContext ? <span className="sr-only">Parsed message context available.</span> : null}
    </>
  )
}

function MessageBody({ text, role }: { text: string; role: "user" | "assistant" }) {
  const assistantParts = role === "assistant" ? splitAssistantMessage(text) : null
  const assistantVisible = assistantParts?.visibleText ?? text
  const userParts = role === "user" ? splitUserMessage(text) : null
  const userVisible = userParts?.visibleText ?? text
  const parsedObjective = userParts?.parsedObjective
  const attachedSkills = userParts?.attachedSkills
  const metadataBlocks = userParts?.metadataBlocks ?? []
  const assistantWithJson =
    role === "assistant" ? formatAssistantJsonBlocks(assistantVisible) : text
  const preparedText =
    role === "assistant" ? normalizeAssistantText(assistantWithJson) : userVisible
  const lines = preparedText.split("\n")
  const shouldCollapse =
    lines.length > COLLAPSE_LINE_THRESHOLD || preparedText.length > COLLAPSE_CHAR_THRESHOLD
  const hasCodeFence = preparedText.includes("```")
  const renderAsLog = role === "assistant" && !hasCodeFence && looksLikeLogBlob(preparedText)
  if (role === "assistant") {
    const thoughtText = assistantParts?.thoughtText
    if (!shouldCollapse || hasCodeFence) {
      return (
        <>
          {preparedText ? (
            renderAsLog ? (
              <pre className="message-log">{preparedText}</pre>
            ) : (
              <Markdown text={preparedText} />
            )
          ) : null}
          {thoughtText ? (
            <details className="assistant-thought">
              <summary>Model reasoning</summary>
              <pre className="message-log assistant-thought-body">{thoughtText}</pre>
            </details>
          ) : null}
        </>
      )
    }
    const preview = summarizeText(preparedText)
    const hint = buildCollapseHint(preparedText)
    return (
      <>
        {preparedText ? (
          <details className="message-collapsible">
            <summary>
              {renderAsLog ? (
                <pre className="message-log">{preview}</pre>
              ) : (
                <Markdown text={preview} />
              )}
              <span className="message-expand-hint">{hint}</span>
            </summary>
            {renderAsLog ? (
              <pre className="message-log">{preparedText}</pre>
            ) : (
              <Markdown text={preparedText} />
            )}
          </details>
        ) : null}
        {thoughtText ? (
          <details className="assistant-thought">
            <summary>Model reasoning</summary>
            <pre className="message-log assistant-thought-body">{thoughtText}</pre>
          </details>
        ) : null}
      </>
    )
  }
  const hookContext = userParts?.hookContext
  const textForCollapse = userVisible
  const hasOnlyContext = textForCollapse.trim().length === 0
  if (!shouldCollapse) {
    return (
      <>
        {!hasOnlyContext ? <pre className="message-text">{textForCollapse}</pre> : null}
        {renderUserContextBlocks(parsedObjective, hookContext, attachedSkills, metadataBlocks)}
      </>
    )
  }
  const preview = summarizeText(textForCollapse)
  const hint = buildCollapseHint(textForCollapse)
  return (
    <>
      <details className="message-collapsible">
        <summary>
          <pre className="message-text">{preview}</pre>
          <span className="message-expand-hint">{hint}</span>
        </summary>
        <pre className="message-text">{textForCollapse}</pre>
      </details>
      {renderUserContextBlocks(parsedObjective, hookContext, attachedSkills, metadataBlocks)}
    </>
  )
}

/* ── Navigation card: projects + sessions list ── */

interface SessionNavProps {
  projects: ProjectSessions[]
  activeAgentPidsByProvider: Record<string, number[]>
  killingPids: Set<number>
  deletingSessionId: string | null
  selectedProjectCwd: string | null
  selectedSessionId: string | null
  onSelectProject: (cwd: string) => void
  onSelectSession: (cwd: string, sessionId: string) => void
  onKillAgentPid: (pid: number) => void | Promise<void>
  onDeleteSession: (cwd: string, sessionId: string) => void | Promise<void>
}

export function SessionNav({
  projects,
  activeAgentPidsByProvider,
  killingPids,
  deletingSessionId,
  selectedProjectCwd,
  selectedSessionId,
  onSelectProject,
  onSelectSession,
  onKillAgentPid,
  onDeleteSession,
}: SessionNavProps) {
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null)

  const sortedProjects = useMemo(
    () => [...projects].sort((a, b) => a.name.localeCompare(b.name)),
    [projects]
  )
  const selectedProject = useMemo(
    () => sortedProjects.find((p) => p.cwd === selectedProjectCwd) ?? null,
    [sortedProjects, selectedProjectCwd]
  )
  const sortedSessions = useMemo(
    () =>
      selectedProject
        ? dedupeSessionsById(selectedProject.sessions).sort((a, b) => {
            const aDisp = a.dispatches ?? 0
            const bDisp = b.dispatches ?? 0
            if (aDisp > 0 && bDisp === 0) return -1
            if (bDisp > 0 && aDisp === 0) return 1
            return (b.lastMessageAt ?? b.mtime) - (a.lastMessageAt ?? a.mtime)
          })
        : null,
    [selectedProject]
  )
  // "Active now" uses verified process liveness first, with recency as fallback.
  const activeThresholdMs = 6 * 60 * 1000
  const activeSessions = useMemo(
    () =>
      sortedSessions?.filter(
        (session) =>
          session.processAlive ||
          Date.now() - (session.lastMessageAt ?? session.mtime) <= activeThresholdMs
      ),
    [sortedSessions]
  )
  const recentSessions = useMemo(
    () =>
      sortedSessions?.filter(
        (session) =>
          !session.processAlive &&
          Date.now() - (session.lastMessageAt ?? session.mtime) > activeThresholdMs
      ),
    [sortedSessions]
  )
  const selectedProjectCwdSafe = selectedProject?.cwd ?? null
  const selectedProjectStatus = selectedProject
    ? parseProjectStatusLine(selectedProject.statusLine).slice(0, 2)
    : []

  const renderSessionRow = (session: SessionPreview) => {
    const processPids = providerProcessPids(session.provider, activeAgentPidsByProvider)
    const processLabel = formatProcessPidLabel(processPids)
    const primaryPid = processPids[0]
    const isDeleting = deletingSessionId === session.id
    const isKilling = processPids.some((pid) => killingPids.has(pid))
    const hasLiveProcess = session.processAlive || processPids.length > 0 || isKilling
    const actionLabel = hasLiveProcess ? "Kill process" : "Delete session"
    const actionDisabled = hasLiveProcess ? isKilling : isDeleting
    const actionIcon = hasLiveProcess ? (isKilling ? "…" : "✕") : isDeleting ? "…" : "🗑"
    const actionTitle =
      hasLiveProcess && primaryPid
        ? `${actionLabel} ${primaryPid}`
        : hasLiveProcess
          ? actionLabel
          : "Delete session transcript and tasks"

    const activeRuntimeSeconds = session.activeDispatch
      ? Math.max(0, Math.round((Date.now() - session.activeDispatch.startedAt) / 1000))
      : 0

    return (
      <li key={session.id} className="session-row">
        <button
          type="button"
          className={cn("session-btn", session.id === selectedSessionId && "selected")}
          aria-pressed={session.id === selectedSessionId}
          onClick={() => {
            if (!selectedProjectCwdSafe) return
            onSelectSession(selectedProjectCwdSafe, session.id)
          }}
        >
          <div className="session-btn-content">
            <div className="session-header">
              <span className="session-provider">
                {(session.provider ?? "unknown").toLowerCase()}
              </span>
              <span className="session-time">
                {formatRelativeTime(session.lastMessageAt ?? session.mtime)}
              </span>
              {session.dispatches ? (
                <span className="session-dispatches" title={`${session.dispatches} dispatches`}>
                  {session.dispatches}
                </span>
              ) : null}
            </div>

            <div className="session-details">
              {processPids.length > 0 ? (
                <span className="agent-process-chip" title={`PIDs: ${processPids.join(", ")}`}>
                  <span className="agent-process-dot" aria-hidden="true" />
                  {processLabel}
                </span>
              ) : null}

              <span className="session-meta">
                {session.activeDispatch ? (
                  <span
                    className="session-active-dispatch"
                    title={session.activeDispatch.requestId}
                  >
                    <span className="session-active-pulse" />
                    {session.activeDispatch.toolName ? (
                      <>
                        <span>{session.activeDispatch.toolName}</span>
                        {session.activeDispatch.toolInputSummary ? (
                          <span className="session-active-detail">
                            {" "}
                            ({session.activeDispatch.toolInputSummary})
                          </span>
                        ) : null}
                      </>
                    ) : (
                      <span>{session.activeDispatch.canonicalEvent}</span>
                    )}
                    <span className="session-active-time"> · {activeRuntimeSeconds}s</span>
                  </span>
                ) : (
                  <span className="session-id-text" title={session.id}>
                    {shortSessionId(session.id)}
                  </span>
                )}
              </span>
            </div>
          </div>
        </button>
        <div className="session-actions">
          {confirmingDeleteId === session.id && !hasLiveProcess ? (
            // biome-ignore lint/a11y/noStaticElementInteractions: dismissal via mouse leave
            <div
              className="session-action-confirm"
              onMouseLeave={() => setConfirmingDeleteId(null)}
            >
              <span className="session-action-confirm-text">Delete?</span>
              <button
                type="button"
                className="session-action-btn session-action-delete session-action-delete-confirm"
                onClick={() => {
                  if (!selectedProjectCwdSafe) return
                  setConfirmingDeleteId(null)
                  void onDeleteSession(selectedProjectCwdSafe, session.id)
                }}
                title="Confirm delete"
              >
                Yes
              </button>
            </div>
          ) : (
            <button
              type="button"
              className={cn(
                "session-action-btn",
                hasLiveProcess ? "session-action-kill" : "session-action-delete"
              )}
              onClick={() => {
                if (hasLiveProcess && primaryPid) {
                  void onKillAgentPid(primaryPid)
                  return
                }
                if (!selectedProjectCwdSafe) return
                setConfirmingDeleteId(session.id)
              }}
              disabled={actionDisabled}
              title={actionTitle}
              aria-label={actionTitle}
            >
              <span className="session-action-icon" aria-hidden="true">
                {actionIcon}
              </span>
              <span className="sr-only">{actionLabel}</span>
            </button>
          )}
        </div>
      </li>
    )
  }

  return (
    <nav className="card bento-nav">
      <div className="nav-inline-header">
        <h2 className="section-title">Projects</h2>
        <span className="nav-count-badge">{sortedProjects.length}</span>
      </div>
      <ul className="project-list" aria-label="Active and recent project directories">
        {sortedProjects.map((project) => {
          const projectState = extractProjectState(project.statusLine)
          const projectStatus = parseProjectStatusLine(project.statusLine).slice(0, 1)
          return (
            <li key={project.cwd}>
              <button
                type="button"
                className={cn("project-btn", project.cwd === selectedProjectCwd && "selected")}
                aria-pressed={project.cwd === selectedProjectCwd}
                onClick={() => onSelectProject(project.cwd)}
              >
                <span className="project-name">
                  {project.name}
                  {projectState ? (
                    <span className={cn("project-state-chip", `project-state-${projectState}`)}>
                      {formatProjectStateLabel(projectState)}
                    </span>
                  ) : null}
                </span>
                <span className="project-meta">
                  {project.sessionCount} sessions · {formatRelativeTime(project.lastSeenAt)}
                </span>
                {projectStatus.length > 0 ? (
                  <span className="project-status-line" title={project.statusLine}>
                    {projectStatus.map((token) => (
                      <span
                        key={`${project.cwd}-${token.label}`}
                        className={cn("project-status-chip", `project-status-${token.tone}`)}
                      >
                        {token.label}
                      </span>
                    ))}
                  </span>
                ) : null}
              </button>
            </li>
          )
        })}
      </ul>
      {selectedProject ? (
        <>
          <div className="nav-inline-header nav-inline-header-sessions">
            <h2 className="section-title nav-section-title">Sessions</h2>
            <span className="nav-count-badge">{sortedSessions?.length ?? 0}</span>
          </div>
          <p className="nav-inline-project">
            {selectedProject.name} · {activeSessions?.length ?? 0} active ·{" "}
            {recentSessions?.length ?? 0} recent
          </p>
          {selectedProjectStatus.length > 0 ? (
            <div
              className="project-status-line nav-inline-status"
              title={selectedProject.statusLine}
            >
              {selectedProjectStatus.map((token) => (
                <span
                  key={`${selectedProject.cwd}-selected-${token.label}`}
                  className={cn("project-status-chip", `project-status-${token.tone}`)}
                >
                  {token.label}
                </span>
              ))}
            </div>
          ) : null}
          <ul className="session-list" aria-label="Sessions for selected project">
            {activeSessions && activeSessions.length > 0 ? (
              <li className="session-group-label">
                Active <span className="session-group-count">{activeSessions.length}</span>
              </li>
            ) : null}
            {activeSessions?.map(renderSessionRow)}
            {recentSessions && recentSessions.length > 0 ? (
              <li className="session-group-label">
                Recent <span className="session-group-count">{recentSessions.length}</span>
              </li>
            ) : null}
            {recentSessions?.map(renderSessionRow)}
          </ul>
        </>
      ) : (
        <p className="empty nav-empty-inline">Select a project to view sessions.</p>
      )}
    </nav>
  )
}

/* ── Tool stats bar ── */

export interface ToolStat {
  name: string
  count: number
}

function isInternalToolName(name: string): boolean {
  return name.trim().toLowerCase() === "structuredoutput"
}

function ToolStatsBar({ stats }: { stats: ToolStat[] }) {
  const visibleStats = useMemo(
    () => stats.filter((stat) => !isInternalToolName(stat.name)),
    [stats]
  )
  const total = useMemo(() => visibleStats.reduce((sum, s) => sum + s.count, 0), [visibleStats])
  if (visibleStats.length === 0) return null
  return (
    <div className="tool-stats-bar">
      <span className="tool-stats-total">{total} tool calls</span>
      <div className="tool-stats-pills">
        {visibleStats.slice(0, 8).map((s) => (
          <span key={s.name} className="tool-stat-pill">
            <span className="tool-stat-name">{s.name}</span>
            <span className="tool-stat-count">{s.count}</span>
          </span>
        ))}
        {visibleStats.length > 8 && (
          <span className="tool-stat-pill tool-stat-more">+{visibleStats.length - 8} more</span>
        )}
      </div>
    </div>
  )
}

/* ── Messages card ── */

interface SessionHealth {
  dispatches?: number
  lastMessageAt?: number
  mtime: number
}

interface MessagesProps {
  messages: SessionMessage[]
  loading: boolean
  newKeys?: Set<string>
  msgKey?: (msg: SessionMessage, i: number) => string
  toolStats?: ToolStat[]
  tasks?: SessionTask[]
  taskSummary?: SessionTaskSummary | null
  tasksLoading?: boolean
  projectTasks?: ProjectTask[]
  projectTaskSummary?: SessionTaskSummary | null
  projectTasksLoading?: boolean
  events?: EventMetric[]
  cacheStatus?: Record<string, number> | null
  activeSession?: SessionHealth | null
  activeHookDispatches?: ActiveHookDispatch[]
}

function TaskStatusBadge({ status }: { status: SessionTask["status"] }) {
  const label = status.replace("_", " ")
  return <span className={cn("task-status", `task-status-${status}`)}>{label}</span>
}

function TaskChecklistMark({ status }: { status: SessionTask["status"] }) {
  const mark =
    status === "completed"
      ? "☑"
      : status === "cancelled"
        ? "☒"
        : status === "in_progress"
          ? "◐"
          : "☐"
  return (
    <span
      className={cn("task-checkmark", `task-checkmark-${status}`)}
      aria-hidden="true"
      title={status.replace("_", " ")}
    >
      {mark}
    </span>
  )
}

function SessionTasksSection({
  tasks,
  summary,
  loading,
}: {
  tasks: SessionTask[]
  summary: SessionTaskSummary | null
  loading: boolean
}) {
  const openTasks = useMemo(
    () => tasks.filter((task) => task.status === "pending" || task.status === "in_progress"),
    [tasks]
  )
  const completedTasks = useMemo(
    () => tasks.filter((task) => task.status === "completed" || task.status === "cancelled"),
    [tasks]
  )
  const renderTaskRow = (task: SessionTask) => {
    const taskTime = task.statusChangedAt ?? task.completionTimestamp
    return (
      <li key={task.id} className="session-task-row">
        <div className="session-task-meta">
          <span className="session-task-id">#{task.id}</span>
          <TaskStatusBadge status={task.status} />
        </div>
        <p className={cn("session-task-subject", `session-task-subject-${task.status}`)}>
          <TaskChecklistMark status={task.status} />
          <span>{task.subject}</span>
        </p>
        {taskTime ? (
          <p className="session-task-time">{formatTime(new Date(taskTime).getTime())}</p>
        ) : null}
        {task.completionEvidence ? (
          <p className="session-task-evidence">{task.completionEvidence}</p>
        ) : null}
      </li>
    )
  }

  return (
    <section className="session-tasks-section" aria-label="Current tasks for selected session">
      <h3 className="session-tasks-title">Session tasks</h3>
      {summary ? (
        <p className="session-tasks-summary">
          {summary.open} open · {summary.completed} completed · {summary.cancelled} cancelled
        </p>
      ) : null}
      {loading ? (
        <p className="empty">Loading tasks...</p>
      ) : tasks.length === 0 ? (
        <p className="empty">No tasks recorded for this session.</p>
      ) : (
        <>
          {openTasks.length > 0 ? (
            <ul className="session-task-list">{openTasks.map(renderTaskRow)}</ul>
          ) : (
            <p className="empty">No open tasks in this session.</p>
          )}
          {completedTasks.length > 0 ? (
            <details className="session-completed-tasks">
              <summary>Show completed ({completedTasks.length})</summary>
              <ul className="session-task-list">{completedTasks.map(renderTaskRow)}</ul>
            </details>
          ) : null}
        </>
      )}
    </section>
  )
}

function ProjectTasksSection({
  tasks,
  summary,
  loading,
}: {
  tasks: ProjectTask[]
  summary: SessionTaskSummary | null
  loading: boolean
}) {
  const [collapsed, setCollapsed] = useState(true)
  const [visibility, setVisibility] = useState<"open" | "all">("open")
  const [expanded, setExpanded] = useState(false)
  const previewLimit = 16
  const openTasks = useMemo(
    () => tasks.filter((task) => task.status === "pending" || task.status === "in_progress"),
    [tasks]
  )
  const scopedTasks = visibility === "open" ? openTasks : tasks
  const visibleTasks = expanded ? scopedTasks : scopedTasks.slice(0, previewLimit)
  const hiddenCount = Math.max(scopedTasks.length - visibleTasks.length, 0)

  return (
    <section className="session-tasks-section" aria-label="All tasks for selected project">
      <div className="session-tasks-heading">
        <h3 className="session-tasks-title">Project tasks</h3>
        <button
          type="button"
          className="task-collapse-btn"
          onClick={() => setCollapsed((value) => !value)}
          aria-expanded={!collapsed}
        >
          {collapsed ? "Expand" : "Collapse"}
        </button>
      </div>
      {summary ? (
        <p className="session-tasks-summary">
          {summary.total} total · {summary.open} open · {summary.completed} completed ·{" "}
          {summary.cancelled} cancelled
        </p>
      ) : null}
      {collapsed ? null : (
        <>
          <div className="session-task-controls">
            <button
              type="button"
              className={cn("task-filter-btn", visibility === "open" && "active")}
              onClick={() => {
                setVisibility("open")
                setExpanded(false)
              }}
              aria-pressed={visibility === "open"}
            >
              Open only ({openTasks.length} shown)
            </button>
            <button
              type="button"
              className={cn("task-filter-btn", visibility === "all" && "active")}
              onClick={() => {
                setVisibility("all")
                setExpanded(false)
              }}
              aria-pressed={visibility === "all"}
            >
              All ({tasks.length} loaded)
            </button>
          </div>
          {summary && tasks.length < summary.total ? (
            <p className="session-tasks-summary">
              Showing latest {tasks.length} of {summary.total} tasks.
            </p>
          ) : null}
          {loading ? (
            <p className="empty">Loading project tasks...</p>
          ) : scopedTasks.length === 0 ? (
            visibility === "open" ? (
              <p className="empty">No open tasks in this project.</p>
            ) : (
              <p className="empty">No tasks recorded for this project.</p>
            )
          ) : (
            <>
              <ul className="session-task-list">
                {visibleTasks.map((task) => {
                  const taskTime = task.statusChangedAt ?? task.completionTimestamp
                  return (
                    <li key={`${task.sessionId}:${task.id}`} className="session-task-row">
                      <div className="session-task-meta">
                        <span className="session-task-id">
                          {task.sessionId.slice(0, 8)}... · #{task.id}
                        </span>
                        <TaskStatusBadge status={task.status} />
                      </div>
                      <p
                        className={cn(
                          "session-task-subject",
                          `session-task-subject-${task.status}`
                        )}
                      >
                        <TaskChecklistMark status={task.status} />
                        <span>{task.subject}</span>
                      </p>
                      {taskTime ? (
                        <p className="session-task-time">
                          {formatTime(new Date(taskTime).getTime())}
                        </p>
                      ) : null}
                    </li>
                  )
                })}
              </ul>
              {hiddenCount > 0 ? (
                <button
                  type="button"
                  className="task-show-more-btn"
                  onClick={() => setExpanded((value) => !value)}
                >
                  {expanded ? "Show fewer tasks" : `Show ${hiddenCount} more tasks`}
                </button>
              ) : null}
            </>
          )}
        </>
      )}
    </section>
  )
}

export function SessionMessages({
  messages,
  loading,
  newKeys,
  msgKey,
  toolStats,
  tasks = [],
  taskSummary = null,
  tasksLoading = false,
  projectTasks = [],
  projectTaskSummary = null,
  projectTasksLoading = false,
  events,
  cacheStatus,
  activeSession,
  activeHookDispatches,
}: MessagesProps) {
  const sorted = useMemo(
    () =>
      [...messages].sort((a, b) => {
        if (!a.timestamp || !b.timestamp) return 0
        return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
      }),
    [messages]
  )
  const grouped = useMemo(() => groupMessages(sorted), [sorted])

  return (
    <section className="card bento-messages">
      <div className="messages-header-row">
        <div>
          <h2 className="section-title">Transcript</h2>
          <p className="section-subtitle">Conversation history for selected session</p>
        </div>
      </div>
      {(events || cacheStatus || activeSession || activeHookDispatches) && (
        <DashboardStats
          events={events}
          cache={cacheStatus ?? undefined}
          activeSession={activeSession ?? null}
          activeHookDispatches={activeHookDispatches ?? []}
          loadedMessageCount={messages.length}
          sessionToolStats={toolStats ?? []}
        />
      )}
      <ProjectTasksSection
        tasks={projectTasks}
        summary={projectTaskSummary}
        loading={projectTasksLoading}
      />
      <SessionTasksSection tasks={tasks} summary={taskSummary} loading={tasksLoading} />
      {toolStats && toolStats.length > 0 && <ToolStatsBar stats={toolStats} />}
      {loading ? (
        <p className="empty">Loading...</p>
      ) : messages.length === 0 ? (
        <p className="empty">No messages for this session.</p>
      ) : (
        <ul className="messages-list" aria-label="Last 30 transcript messages">
          {grouped.map(({ message, count, originalIndices }, i) => {
            const role = message.role === "assistant" ? "Assistant" : "User"
            const timestamp = message.timestamp
              ? formatTime(new Date(message.timestamp).getTime())
              : "Unknown time"
            const groupKeys = msgKey
              ? originalIndices.map((idx) => msgKey(sorted[idx]!, idx))
              : [`${message.timestamp}-${i}`]
            const key = groupKeys[0]!
            const isNew = groupKeys.some((groupKey) => newKeys?.has(groupKey) ?? false)
            const adjacentSkillName =
              skillNameFromMessage(grouped[i - 1]?.message) ??
              skillNameFromMessage(grouped[i + 1]?.message)
            const parsedSkillPayload =
              message.role === "user" ? parseSkillPayload(message.text ?? "") : null
            const showSkillPayload =
              message.role === "user" && Boolean(adjacentSkillName) && Boolean(parsedSkillPayload)
            const skillBody = parsedSkillPayload?.body ?? ""
            const collapseSkillBody =
              skillBody.length > 300 || skillBody.split("\n").length > COLLAPSE_LINE_THRESHOLD
            const skillPreview = collapseSkillBody ? summarizeText(skillBody) : skillBody
            const isToolOnlyAssistant =
              message.role === "assistant" &&
              (message.text ?? "").trim().length === 0 &&
              (message.toolCalls?.length ?? 0) > 0
            return (
              <li
                key={key}
                className={cn(
                  "message-row",
                  message.role,
                  isNew && "message-new",
                  isToolOnlyAssistant && "message-row-tool-only"
                )}
              >
                <div className="message-meta">
                  <span className="message-role">{role}</span>
                  <span className="message-meta-right">
                    {count > 1 ? <span className="message-repeat-badge">x{count}</span> : null}
                    <span>{timestamp}</span>
                  </span>
                </div>
                {message.text &&
                  (showSkillPayload ? (
                    <div className="skill-payload-box">
                      <div className="skill-payload-header">
                        <span className="skill-payload-label">Skill content</span>
                        <code className="skill-payload-name">{adjacentSkillName}</code>
                      </div>
                      {parsedSkillPayload?.baseDir ? (
                        <p className="skill-payload-base">
                          <span className="skill-payload-base-label">base dir</span>
                          <code className="skill-payload-base-path">
                            {compactPath(parsedSkillPayload.baseDir, 90)}
                          </code>
                        </p>
                      ) : null}
                      {collapseSkillBody ? (
                        <details className="tool-raw-json">
                          <summary>{skillPreview}</summary>
                          <pre className="message-text">{skillBody}</pre>
                        </details>
                      ) : (
                        <pre className="message-text">{skillBody}</pre>
                      )}
                    </div>
                  ) : (
                    <MessageBody text={message.text} role={message.role} />
                  ))}
                {message.toolCalls &&
                  message.toolCalls.length > 0 &&
                  (isToolOnlyAssistant ? (
                    <div className="tool-calls tool-calls-verbose">
                      {message.toolCalls.map((tc) => (
                        <div
                          key={`${tc.name}-${tc.detail}`}
                          className="tool-call tool-call-verbose"
                        >
                          {(() => {
                            const parsedDetail = parseToolCallDetail(tc.name, tc.detail)
                            const isBash = tc.name.toLowerCase() === "bash"
                            const swizTask =
                              isBash && parsedDetail.command
                                ? parseSwizTasksCommand(parsedDetail.command)
                                : null
                            const searchParams = parseSearchToolParams(tc.name, tc.detail)
                            const rawJson = parsedDetail.rawJson
                            const shouldCollapseRawJson =
                              !isBash &&
                              typeof rawJson === "string" &&
                              rawJson.length > TOOL_RAW_JSON_COLLAPSE_THRESHOLD
                            const rawJsonPreview =
                              rawJson && shouldCollapseRawJson
                                ? summarizeRawJson(rawJson, TOOL_RAW_JSON_COLLAPSE_THRESHOLD)
                                : null
                            return (
                              <div className="tool-call-body">
                                <div className="tool-call-header">
                                  <span className="tool-name">{tc.name}</span>
                                </div>
                                {isBash && swizTask ? (
                                  <div className="tool-first-party-call">
                                    <p className="tool-first-party-title">swiz tasks</p>
                                    <ul className="tool-param-list">
                                      <li className="tool-param-item">
                                        <span className="tool-param-label">action</span>
                                        <code className="tool-param-value">{swizTask.action}</code>
                                      </li>
                                      {swizTask.taskId ? (
                                        <li className="tool-param-item">
                                          <span className="tool-param-label">task</span>
                                          <code className="tool-param-value">
                                            {swizTask.taskId}
                                          </code>
                                        </li>
                                      ) : null}
                                      {swizTask.status ? (
                                        <li className="tool-param-item">
                                          <span className="tool-param-label">status</span>
                                          <code className="tool-param-value">
                                            {swizTask.status}
                                          </code>
                                        </li>
                                      ) : null}
                                      {swizTask.subject ? (
                                        <li className="tool-param-item">
                                          <span className="tool-param-label">subject</span>
                                          <code className="tool-param-value">
                                            {swizTask.subject}
                                          </code>
                                        </li>
                                      ) : null}
                                      {swizTask.evidence ? (
                                        <li className="tool-param-item">
                                          <span className="tool-param-label">evidence</span>
                                          <code className="tool-param-value">
                                            {swizTask.evidence}
                                          </code>
                                        </li>
                                      ) : null}
                                    </ul>
                                    <details className="tool-raw-json">
                                      <summary>Full command</summary>
                                      <pre className="tool-command-block">
                                        {parsedDetail.command}
                                      </pre>
                                    </details>
                                  </div>
                                ) : null}
                                {isBash && parsedDetail.command && !swizTask ? (
                                  <pre className="tool-command-block">{parsedDetail.command}</pre>
                                ) : null}
                                {isBash && parsedDetail.description ? (
                                  <p className="tool-call-description">
                                    {parsedDetail.description}
                                  </p>
                                ) : null}
                                {parsedDetail.commonFields.length > 0 ? (
                                  <ul className="tool-param-list">
                                    {parsedDetail.commonFields.map((field) => (
                                      <li
                                        key={`${field.label}:${field.value}`}
                                        className="tool-param-item"
                                      >
                                        <span className="tool-param-label">{field.label}</span>
                                        <code className="tool-param-value">{field.value}</code>
                                      </li>
                                    ))}
                                  </ul>
                                ) : null}
                                {!isBash && searchParams ? (
                                  <div className="tool-first-party-call">
                                    <p className="tool-first-party-title">{tc.name} search</p>
                                    {searchParams.pattern ? (
                                      <pre className="tool-command-block">
                                        {searchParams.pattern}
                                      </pre>
                                    ) : null}
                                    <ul className="tool-param-list">
                                      {searchParams.path ? (
                                        <li className="tool-param-item">
                                          <span className="tool-param-label">path</span>
                                          <code className="tool-param-value">
                                            {compactPath(searchParams.path, 90)}
                                          </code>
                                        </li>
                                      ) : null}
                                      {searchParams.outputMode ? (
                                        <li className="tool-param-item">
                                          <span className="tool-param-label">output</span>
                                          <code className="tool-param-value">
                                            {searchParams.outputMode}
                                          </code>
                                        </li>
                                      ) : null}
                                      {searchParams.options.map((option) => (
                                        <li
                                          key={`${option.label}:${option.value}`}
                                          className="tool-param-item"
                                        >
                                          <span className="tool-param-label">{option.label}</span>
                                          <code className="tool-param-value">{option.value}</code>
                                        </li>
                                      ))}
                                    </ul>
                                  </div>
                                ) : null}
                                {!isBash && rawJson && shouldCollapseRawJson ? (
                                  <details className="tool-raw-json">
                                    <summary>{rawJsonPreview}</summary>
                                    <pre className="tool-detail-full">{rawJson}</pre>
                                  </details>
                                ) : null}
                                {!isBash && rawJson && !shouldCollapseRawJson ? (
                                  <pre className="tool-detail-full">{rawJson}</pre>
                                ) : null}
                              </div>
                            )
                          })()}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <ul className="tool-calls">
                      {message.toolCalls.map((tc) => (
                        <li key={`${tc.name}-${tc.detail}`} className="tool-call">
                          <span className="tool-name">{tc.name}</span>
                          {tc.detail && (
                            <span
                              className="tool-detail"
                              // biome-ignore lint/security/noDangerouslySetInnerHtml: escaped via renderInline
                              dangerouslySetInnerHTML={{ __html: renderInline(tc.detail) }}
                            />
                          )}
                        </li>
                      ))}
                    </ul>
                  ))}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
