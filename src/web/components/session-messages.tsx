import { useMemo } from "react"
import { cn } from "../lib/cn.ts"
import type { EventMetric } from "../lib/dashboard-helpers.ts"
import type { ActiveHookDispatch } from "../lib/dashboard-hooks.ts"
import { DashboardStats } from "./dashboard-stats.tsx"
import { renderInline } from "./markdown.tsx"
import { MessageBody } from "./message-body.tsx"
import type {
  ProjectTask,
  SessionMessage,
  SessionTask,
  SessionTaskSummary,
  ToolStat,
} from "./session-browser-types.ts"
import {
  COLLAPSE_LINE_THRESHOLD,
  compactPath,
  formatTime,
  groupMessages,
  isInternalToolName,
  parseSearchToolParams,
  parseSkillPayload,
  parseSwizTasksCommand,
  parseToolCallDetail,
  skillNameFromMessage,
  summarizeRawJson,
  summarizeText,
  TOOL_RAW_JSON_COLLAPSE_THRESHOLD,
} from "./session-browser-utils.ts"
import { ProjectTasksSection, SessionTasksSection } from "./session-tasks.tsx"

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

function SwizTaskCallDisplay({
  swizTask,
  command,
}: {
  swizTask: {
    action: string
    taskId?: string | null
    status?: string | null
    subject?: string | null
    evidence?: string | null
  }
  command?: string | null
}) {
  const fields: Array<{ label: string; value: string }> = [
    { label: "action", value: swizTask.action },
  ]
  if (swizTask.taskId) fields.push({ label: "task", value: String(swizTask.taskId) })
  if (swizTask.status) fields.push({ label: "status", value: String(swizTask.status) })
  if (swizTask.subject) fields.push({ label: "subject", value: String(swizTask.subject) })
  if (swizTask.evidence) fields.push({ label: "evidence", value: String(swizTask.evidence) })
  return (
    <div className="tool-first-party-call">
      <p className="tool-first-party-title">swiz tasks</p>
      <ul className="tool-param-list">
        {fields.map((f) => (
          <li key={`${f.label}:${f.value}`} className="tool-param-item">
            <span className="tool-param-label">{f.label}</span>
            <code className="tool-param-value">{f.value}</code>
          </li>
        ))}
      </ul>
      <details className="tool-raw-json">
        <summary>Full command</summary>
        <pre className="tool-command-block">{command}</pre>
      </details>
    </div>
  )
}

function SearchToolDisplay({
  toolName,
  searchParams,
}: {
  toolName: string
  searchParams: {
    pattern?: string | null
    path?: string | null
    outputMode?: string | null
    options: Array<{ label: string; value: string }>
  }
}) {
  return (
    <div className="tool-first-party-call">
      <p className="tool-first-party-title">{toolName} search</p>
      {searchParams.pattern ? (
        <pre className="tool-command-block">{searchParams.pattern}</pre>
      ) : null}
      <ul className="tool-param-list">
        {searchParams.path ? (
          <li className="tool-param-item">
            <span className="tool-param-label">path</span>
            <code className="tool-param-value">{compactPath(searchParams.path, 90)}</code>
          </li>
        ) : null}
        {searchParams.outputMode ? (
          <li className="tool-param-item">
            <span className="tool-param-label">output</span>
            <code className="tool-param-value">{searchParams.outputMode}</code>
          </li>
        ) : null}
        {searchParams.options.map((option) => (
          <li key={`${option.label}:${option.value}`} className="tool-param-item">
            <span className="tool-param-label">{option.label}</span>
            <code className="tool-param-value">{option.value}</code>
          </li>
        ))}
      </ul>
    </div>
  )
}

function RawJsonDisplay({
  rawJson,
  isBash,
}: {
  rawJson: string | null | undefined
  isBash: boolean
}) {
  if (isBash || !rawJson) return null
  const shouldCollapse = rawJson.length > TOOL_RAW_JSON_COLLAPSE_THRESHOLD
  if (shouldCollapse) {
    return (
      <details className="tool-raw-json">
        <summary>{summarizeRawJson(rawJson, TOOL_RAW_JSON_COLLAPSE_THRESHOLD)}</summary>
        <pre className="tool-detail-full">{rawJson}</pre>
      </details>
    )
  }
  return <pre className="tool-detail-full">{rawJson}</pre>
}

function BashToolBody({ parsedDetail }: { parsedDetail: ReturnType<typeof parseToolCallDetail> }) {
  const swizTask = parsedDetail.command ? parseSwizTasksCommand(parsedDetail.command) : null
  if (swizTask) {
    return <SwizTaskCallDisplay swizTask={swizTask} command={parsedDetail.command} />
  }
  return (
    <>
      {parsedDetail.command ? (
        <pre className="tool-command-block">{parsedDetail.command}</pre>
      ) : null}
      {parsedDetail.description ? (
        <p className="tool-call-description">{parsedDetail.description}</p>
      ) : null}
    </>
  )
}

function CommonFieldsList({ fields }: { fields: Array<{ label: string; value: string }> }) {
  if (fields.length === 0) return null
  return (
    <ul className="tool-param-list">
      {fields.map((field) => (
        <li key={`${field.label}:${field.value}`} className="tool-param-item">
          <span className="tool-param-label">{field.label}</span>
          <code className="tool-param-value">{field.value}</code>
        </li>
      ))}
    </ul>
  )
}

function VerboseToolCall({ tc }: { tc: { name: string; detail: string } }) {
  const parsedDetail = parseToolCallDetail(tc.name, tc.detail)
  const isBash = tc.name.toLowerCase() === "bash"
  const searchParams = !isBash ? parseSearchToolParams(tc.name, tc.detail) : null

  return (
    <div className="tool-call tool-call-verbose">
      <div className="tool-call-body">
        <div className="tool-call-header">
          <span className="tool-name">{tc.name}</span>
        </div>
        {isBash ? <BashToolBody parsedDetail={parsedDetail} /> : null}
        <CommonFieldsList fields={parsedDetail.commonFields} />
        {searchParams ? <SearchToolDisplay toolName={tc.name} searchParams={searchParams} /> : null}
        <RawJsonDisplay rawJson={parsedDetail.rawJson} isBash={isBash} />
      </div>
    </div>
  )
}

function SkillPayloadDisplay({
  adjacentSkillName,
  parsedSkillPayload,
}: {
  adjacentSkillName: string | null | undefined
  parsedSkillPayload: { baseDir?: string | null; body: string } | null
}) {
  if (!parsedSkillPayload) return null
  const skillBody = parsedSkillPayload.body
  const collapseSkillBody =
    skillBody.length > 300 || skillBody.split("\n").length > COLLAPSE_LINE_THRESHOLD
  const skillPreview = collapseSkillBody ? summarizeText(skillBody) : skillBody
  return (
    <div className="skill-payload-box">
      <div className="skill-payload-header">
        <span className="skill-payload-label">Skill content</span>
        <code className="skill-payload-name">{adjacentSkillName}</code>
      </div>
      {parsedSkillPayload.baseDir ? (
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
  )
}

function ToolCallsList({
  toolCalls,
  verbose,
}: {
  toolCalls: Array<{ name: string; detail: string }>
  verbose: boolean
}) {
  if (verbose) {
    return (
      <div className="tool-calls tool-calls-verbose">
        {toolCalls.map((tc) => (
          <VerboseToolCall key={`${tc.name}-${tc.detail}`} tc={tc} />
        ))}
      </div>
    )
  }
  return (
    <ul className="tool-calls">
      {toolCalls.map((tc) => (
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
  )
}

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

interface MessageRowProps {
  message: SessionMessage
  count: number
  isNew: boolean
  adjacentSkillName: string | null | undefined
  isToolOnlyAssistant: boolean
}

function MessageTextContent({
  message,
  adjacentSkillName,
}: {
  message: SessionMessage
  adjacentSkillName: string | null | undefined
}) {
  if (!message.text) return null
  const parsedSkillPayload = message.role === "user" ? parseSkillPayload(message.text) : null
  const showSkill =
    message.role === "user" && Boolean(adjacentSkillName) && Boolean(parsedSkillPayload)
  if (showSkill) {
    return (
      <SkillPayloadDisplay
        adjacentSkillName={adjacentSkillName}
        parsedSkillPayload={parsedSkillPayload}
      />
    )
  }
  return <MessageBody text={message.text} role={message.role} />
}

function MessageRow({
  message,
  count,
  isNew,
  adjacentSkillName,
  isToolOnlyAssistant,
}: MessageRowProps) {
  const role = message.role === "assistant" ? "Assistant" : "User"
  const timestamp = message.timestamp
    ? formatTime(new Date(message.timestamp).getTime())
    : "Unknown time"

  return (
    <li
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
      <MessageTextContent message={message} adjacentSkillName={adjacentSkillName} />
      {message.toolCalls && message.toolCalls.length > 0 && (
        <ToolCallsList toolCalls={message.toolCalls} verbose={isToolOnlyAssistant} />
      )}
    </li>
  )
}

function resolveMessageRowProps(
  grouped: ReturnType<typeof groupMessages>,
  sorted: SessionMessage[],
  i: number,
  msgKey: MessagesProps["msgKey"],
  newKeys: Set<string> | undefined
): { key: string } & MessageRowProps {
  const { message, count, originalIndices } = grouped[i]!
  const groupKeys = msgKey
    ? originalIndices.map((idx) => msgKey(sorted[idx]!, idx))
    : [`${message.timestamp}-${i}`]
  const key = groupKeys[0]!
  const isNew = groupKeys.some((groupKey) => newKeys?.has(groupKey) ?? false)
  const adjacentSkillName =
    skillNameFromMessage(grouped[i - 1]?.message) ?? skillNameFromMessage(grouped[i + 1]?.message)
  const isToolOnlyAssistant =
    message.role === "assistant" &&
    (message.text ?? "").trim().length === 0 &&
    (message.toolCalls?.length ?? 0) > 0
  return {
    key,
    message,
    count,
    isNew,
    adjacentSkillName,
    isToolOnlyAssistant,
  }
}

function MessagesContent({
  messages,
  loading,
  newKeys,
  msgKey,
  grouped,
  sorted,
}: {
  messages: SessionMessage[]
  loading: boolean
  newKeys?: Set<string>
  msgKey?: MessagesProps["msgKey"]
  grouped: ReturnType<typeof groupMessages>
  sorted: SessionMessage[]
}) {
  if (loading) {
    return <p className="empty p-8 text-center text-zinc-500">Loading...</p>
  }
  if (messages.length === 0) {
    return <p className="empty p-8 text-center text-zinc-500">No messages for this session.</p>
  }
  return (
    <ul className="messages-list flex-1 pb-16" aria-label="Last 30 transcript messages">
      {grouped.map((_, i) => {
        const { key, ...rowProps } = resolveMessageRowProps(grouped, sorted, i, msgKey, newKeys)
        return <MessageRow key={key} {...rowProps} />
      })}
    </ul>
  )
}

function SessionStatsBar({
  events,
  cacheStatus,
  activeSession,
  activeHookDispatches,
  messages,
  toolStats,
}: Pick<
  MessagesProps,
  "events" | "cacheStatus" | "activeSession" | "activeHookDispatches" | "messages" | "toolStats"
>) {
  const hasStats = events || cacheStatus || activeSession || activeHookDispatches
  if (!hasStats) return null
  return (
    <DashboardStats
      events={events}
      cache={cacheStatus ?? undefined}
      activeSession={activeSession ?? null}
      activeHookDispatches={activeHookDispatches ?? []}
      loadedMessageCount={messages.length}
      sessionToolStats={toolStats ?? []}
    />
  )
}

export function SessionMessages(props: MessagesProps) {
  const {
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
  } = props
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
    <section className="card bento-messages flex flex-col h-full max-h-full overflow-hidden">
      <div className="messages-header-row flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6 shrink-0">
        <div>
          <h2 className="section-title">Transcript</h2>
          <p className="section-subtitle">Conversation history for selected session</p>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto min-h-0 flex flex-col">
        <SessionStatsBar {...props} />
        <ProjectTasksSection
          tasks={projectTasks}
          summary={projectTaskSummary}
          loading={projectTasksLoading}
        />
        <SessionTasksSection tasks={tasks} summary={taskSummary} loading={tasksLoading} />
        {toolStats && toolStats.length > 0 && <ToolStatsBar stats={toolStats} />}
        <MessagesContent
          messages={messages}
          loading={loading}
          newKeys={newKeys}
          msgKey={msgKey}
          grouped={grouped}
          sorted={sorted}
        />
      </div>
    </section>
  )
}
