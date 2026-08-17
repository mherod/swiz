import { type KeyboardEvent, type ReactElement, type ReactNode, useMemo } from "react"
import { cn } from "../lib/cn.ts"
import type { EventMetric } from "../lib/dashboard-helpers.ts"
import {
  type ActiveHookDispatch,
  SESSION_MESSAGE_LIMIT,
  type SessionTokenStats,
} from "../lib/dashboard-hooks.ts"
import { DashboardStats } from "./dashboard-stats.tsx"
import { InlineMarkdown } from "./inline-markdown.tsx"
import { MessageBody } from "./message-body.tsx"
import type {
  GroupedSessionMessage,
  ParsedSkillPayload,
  ProjectTask,
  SessionHealth,
  SessionMessage,
  SessionTask,
  SessionTaskSummary,
  ToolStat,
} from "./session-browser-types.ts"
import {
  COLLAPSE_LINE_THRESHOLD,
  classifyTool,
  compactPath,
  formatTime,
  groupMessages,
  isInternalToolName,
  parseFileToolCall,
  parseSearchToolParams,
  parseSkillPayload,
  parseSwizTasksCommand,
  parseTaskToolCall,
  parseToolCallDetail,
  skillExchangeMergeAt,
  skillNameFromMessage,
  summarizeRawJson,
  summarizeText,
  TOOL_RAW_JSON_COLLAPSE_THRESHOLD,
  toolCategoryIcon,
} from "./session-browser-utils.ts"
import { ProjectTasksSection, SessionTasksSection } from "./session-tasks.tsx"

function ToolStatsBar({ stats }: { stats: ToolStat[] }) {
  const visibleStats = useMemo(
    () => stats.filter((stat) => !isInternalToolName(stat.name)),
    [stats]
  )
  if (visibleStats.length === 0) return null
  return (
    <details className="tool-stats-bar">
      <summary>
        <span className="tool-stats-total">Tool mix</span>
        <span className="tool-stats-hint">View top {Math.min(visibleStats.length, 8)}</span>
      </summary>
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
    </details>
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

function TaskToolDisplay({
  task,
  rawJson,
  className,
}: {
  task: ReturnType<typeof parseTaskToolCall>
  rawJson: string | null | undefined
  className?: string
}) {
  if (!task) return null
  const fields: Array<{ label: string; value: string }> = [{ label: "action", value: task.action }]
  if (task.taskId) fields.push({ label: "task", value: task.taskId })
  if (task.status) fields.push({ label: "status", value: task.status })
  return (
    <div className={cn("tool-first-party-call", className)}>
      <p className="tool-first-party-title">
        <span className="tool-category-icon" aria-hidden="true">
          ☑
        </span>{" "}
        Task {task.action}
      </p>
      {task.subject ? <p className="tool-call-subject">{task.subject}</p> : null}
      <CommonFieldsList fields={fields} />
      {task.activeForm ? <p className="tool-call-description">{task.activeForm}</p> : null}
      {rawJson ? (
        <details className="tool-raw-json">
          <summary>Parameters</summary>
          <pre className="tool-detail-full">{rawJson}</pre>
        </details>
      ) : null}
    </div>
  )
}

function getActionLabel(action: string): string {
  switch (action) {
    case "read":
      return "Reading"
    case "edit":
      return "Editing"
    case "write":
      return "Writing"
    default:
      return "Searching"
  }
}

function FileParamsDisplay({ offset, limit }: { offset?: number | null; limit?: number | null }) {
  const hasParams = offset != null || limit != null
  if (!hasParams) return null
  return (
    <ul className="tool-param-list">
      {offset != null && (
        <li className="tool-param-item">
          <span className="tool-param-label">offset</span>
          <code className="tool-param-value">line {offset}</code>
        </li>
      )}
      {limit != null && (
        <li className="tool-param-item">
          <span className="tool-param-label">limit</span>
          <code className="tool-param-value">{limit} lines</code>
        </li>
      )}
    </ul>
  )
}

function FileEditDiff({ oldString, newString }: { oldString: string; newString: string }) {
  return (
    <details className="tool-raw-json">
      <summary>Edit diff</summary>
      <pre className="tool-detail-full tool-diff-old">- {summarizeText(oldString)}</pre>
      <pre className="tool-detail-full tool-diff-new">+ {summarizeText(newString)}</pre>
    </details>
  )
}

function FileToolDisplay({
  file,
  rawJson,
  className,
}: {
  file: ReturnType<typeof parseFileToolCall>
  rawJson: string | null | undefined
  className?: string
}) {
  if (!file) return null
  const actionLabel = getActionLabel(file.action)
  const hasDiff = file.oldString && file.newString
  const hasRawJson = rawJson && !file.oldString

  return (
    <div className={cn("tool-first-party-call", className)}>
      <p className="tool-first-party-title">
        <span className="tool-category-icon" aria-hidden="true">
          ◇
        </span>{" "}
        {actionLabel}
      </p>
      <pre className="tool-command-block">{compactPath(file.filePath, 120)}</pre>
      <FileParamsDisplay offset={file.offset} limit={file.limit} />
      {hasDiff && <FileEditDiff oldString={file.oldString!} newString={file.newString!} />}
      {hasRawJson && (
        <details className="tool-raw-json">
          <summary>Parameters</summary>
          <pre className="tool-detail-full">{rawJson}</pre>
        </details>
      )}
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

function RawToolInput({ detail }: { detail: string }) {
  if (!detail.trim()) return null
  const shouldCollapse = detail.length > TOOL_RAW_JSON_COLLAPSE_THRESHOLD
  if (!shouldCollapse) return <pre className="tool-command-block">{detail}</pre>
  return (
    <details className="tool-raw-json">
      <summary>{summarizeText(detail)}</summary>
      <pre className="tool-detail-full">{detail}</pre>
    </details>
  )
}

function codeFieldFromJson(rawJson: string | null): string | null {
  if (!rawJson) return null
  try {
    const parsed = JSON.parse(rawJson) as Record<string, unknown>
    return typeof parsed.code === "string" ? parsed.code : null
  } catch {
    return null
  }
}

function CodeToolCall({ code, count, name }: { code: string; count: number; name: string }) {
  const preview = summarizeCodeCall(code)
  return (
    <details className="tool-call tool-call-verbose tool-call-exec tool-category-shell">
      <summary className="tool-call-exec-summary">
        <span className="tool-name">{name}</span>
        {count > 1 ? <span className="message-repeat-badge">x{count}</span> : null}
        <code className="tool-call-exec-preview">{preview}</code>
      </summary>
      <pre className="tool-command-block">{code}</pre>
    </details>
  )
}

function summarizeCodeCall(code: string): string {
  const normalized = code.replace(/\s+/g, " ").trim()
  if (/tools\.update_plan\b/.test(normalized)) return "Update plan"
  if (/tools\.write_stdin\b/.test(normalized)) return "Poll running command"
  if (/tools\.apply_patch\b/.test(normalized)) return "Apply patch"
  const commandMatch = /cmd:\s*["']([^"']+)["']/.exec(normalized)
  if (commandMatch?.[1]) return summarizeText(commandMatch[1])
  return summarizeText(normalized)
}

// eslint-disable-next-line complexity -- tool-specific renderers intentionally branch by payload shape
function VerboseToolCall({
  tc,
  count = 1,
}: {
  tc: { name: string; detail: string }
  count?: number
}) {
  const parsedDetail = parseToolCallDetail(tc.name, tc.detail)
  const isBash = tc.name.toLowerCase() === "bash"
  const category = classifyTool(tc.name)
  const icon = toolCategoryIcon(category)
  const searchParams = !isBash ? parseSearchToolParams(tc.name, tc.detail) : null
  const taskTool = category === "task" ? parseTaskToolCall(tc.name, tc.detail) : null
  const fileTool = category === "file" ? parseFileToolCall(tc.name, tc.detail) : null
  const codeField = codeFieldFromJson(parsedDetail.rawJson)
  const execCode = tc.name.toLowerCase() === "exec" && !codeField ? tc.detail : null
  const code = codeField ?? execCode

  if (code) return <CodeToolCall code={code} count={count} name={tc.name} />

  if (taskTool) {
    return (
      <TaskToolDisplay
        task={taskTool}
        rawJson={parsedDetail.rawJson}
        className={`tool-call tool-call-verbose tool-category-${category}`}
      />
    )
  }

  if (fileTool) {
    return (
      <FileToolDisplay
        file={fileTool}
        rawJson={parsedDetail.rawJson}
        className={`tool-call tool-call-verbose tool-category-${category}`}
      />
    )
  }

  return (
    <div className={`tool-call tool-call-verbose tool-category-${category}`}>
      <span className="tool-category-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="tool-name">{tc.name}</span>
      {count > 1 ? <span className="message-repeat-badge">x{count}</span> : null}
      {isBash ? <BashToolBody parsedDetail={parsedDetail} /> : null}
      <CommonFieldsList fields={parsedDetail.commonFields} />
      {searchParams ? <SearchToolDisplay toolName={tc.name} searchParams={searchParams} /> : null}
      <RawJsonDisplay rawJson={parsedDetail.rawJson} isBash={isBash} />
      {!isBash && !parsedDetail.rawJson && !searchParams ? (
        <RawToolInput detail={tc.detail} />
      ) : null}
    </div>
  )
}

function SkillPayloadDisplay({
  adjacentSkillName,
  parsedSkillPayload,
  showNameHeader = true,
}: {
  adjacentSkillName: string | null | undefined
  parsedSkillPayload: { baseDir?: string | null; body: string } | null
  /** When false, the parent already shows the skill name (e.g. merged skill exchange row). */
  showNameHeader?: boolean
}) {
  if (!parsedSkillPayload) return null
  const skillBody = parsedSkillPayload.body
  const collapseSkillBody =
    skillBody.length > 300 || skillBody.split("\n").length > COLLAPSE_LINE_THRESHOLD
  const skillPreview = collapseSkillBody ? summarizeText(skillBody) : skillBody
  return (
    <div className={cn("skill-payload-box", !showNameHeader && "skill-payload-box-nested")}>
      {showNameHeader ? (
        <div className="skill-payload-header">
          <span className="skill-payload-label">Skill content</span>
          <code className="skill-payload-name">{adjacentSkillName}</code>
        </div>
      ) : (
        <div className="skill-payload-header skill-payload-header-minor">
          <span className="skill-payload-label">Injected body</span>
        </div>
      )}
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
  const groupedCalls = useMemo(() => {
    const groups = new Map<string, { call: { name: string; detail: string }; count: number }>()
    for (const call of toolCalls) {
      const key = [call.name, call.detail].join("\u0000")
      const existing = groups.get(key)
      if (existing) existing.count += 1
      else groups.set(key, { call, count: 1 })
    }
    return [...groups.values()]
  }, [toolCalls])
  if (verbose) return <VerboseToolCalls groupedCalls={groupedCalls} />
  return (
    <ul className="tool-calls">
      {groupedCalls.map(({ call: tc, count }) => {
        const category = classifyTool(tc.name)
        const icon = toolCategoryIcon(category)
        return (
          <li key={`${tc.name}-${tc.detail}`} className={`tool-call tool-category-${category}`}>
            <span className="tool-category-icon" aria-hidden="true">
              {icon}
            </span>
            <span className="tool-name">{tc.name}</span>
            {count > 1 ? <span className="message-repeat-badge">x{count}</span> : null}
            {tc.detail && (
              <span className="tool-detail">
                <InlineMarkdown text={tc.detail} />
              </span>
            )}
          </li>
        )
      })}
    </ul>
  )
}

function VerboseToolCalls({
  groupedCalls,
}: {
  groupedCalls: Array<{ call: { name: string; detail: string }; count: number }>
}) {
  const visibleCalls = groupedCalls.slice(0, 6)
  const hiddenCalls = groupedCalls.slice(6)
  return (
    <div className="tool-calls tool-calls-verbose">
      {visibleCalls.map(({ call, count }) => (
        <VerboseToolCall key={`${call.name}-${call.detail}`} tc={call} count={count} />
      ))}
      {hiddenCalls.length > 0 ? (
        <details className="tool-calls-more">
          <summary>Show {hiddenCalls.length} more distinct calls</summary>
          <div className="tool-calls-more-list">
            {hiddenCalls.map(({ call, count }) => (
              <VerboseToolCall key={`${call.name}-${call.detail}`} tc={call} count={count} />
            ))}
          </div>
        </details>
      ) : null}
    </div>
  )
}

interface MessagesProps {
  className?: string
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
  sessionTokenStats?: SessionTokenStats | null
  monitorMetric?: { count?: number; avgMs?: number; p95Ms?: number } | null
  hideTasks?: boolean
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
          <time
            dateTime={message.timestamp ?? undefined}
            title={message.timestamp ? new Date(message.timestamp).toLocaleString() : undefined}
          >
            {timestamp}
          </time>
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

function groupKeysForGrouped(
  entry: GroupedSessionMessage,
  sorted: SessionMessage[],
  msgKey: MessagesProps["msgKey"] | undefined,
  fallbackTag: string
): string[] {
  return msgKey
    ? entry.originalIndices.map((idx) => msgKey(sorted[idx]!, idx))
    : [`${entry.message.timestamp}-${fallbackTag}`]
}

function formatTimesDisplay(
  userMsg: SessionMessage,
  asstMsg: SessionMessage
): { assistantTime: string; userTime: string } {
  const assistantTime = asstMsg.timestamp
    ? formatTime(new Date(asstMsg.timestamp).getTime())
    : "Unknown time"
  const userTime = userMsg.timestamp
    ? formatTime(new Date(userMsg.timestamp).getTime())
    : "Unknown time"
  return { assistantTime, userTime }
}

function buildRepeatLabel(userCount: number, assistantCount: number): string | null {
  const parts: string[] = []
  if (userCount > 1) parts.push(`User ×${userCount}`)
  if (assistantCount > 1) parts.push(`Asst ×${assistantCount}`)
  return parts.length > 0 ? parts.join(" · ") : null
}

function SkillExchangeMetadata({
  skillName,
  repeatLabel,
  assistantTime,
  userTime,
  userMsg,
  asstMsg,
}: {
  skillName: string
  repeatLabel: string | null
  assistantTime: string
  userTime: string
  userMsg: SessionMessage
  asstMsg: SessionMessage
}) {
  return (
    <div className="message-meta">
      <span className="message-role message-role-skill-exchange">
        <span aria-hidden className="skill-exchange-icon">
          ⚡
        </span>
        Skill
        <code className="skill-exchange-name">{skillName}</code>
      </span>
      <span className="message-meta-right">
        {repeatLabel ? <span className="message-repeat-badge">{repeatLabel}</span> : null}
        <span className="skill-exchange-times">
          <time className="skill-exchange-time-chunk" dateTime={asstMsg.timestamp ?? undefined}>
            {assistantTime}
          </time>
          <span aria-hidden className="skill-exchange-time-sep">
            →
          </span>
          <time className="skill-exchange-time-chunk" dateTime={userMsg.timestamp ?? undefined}>
            {userTime}
          </time>
        </span>
      </span>
    </div>
  )
}

function SkillExchangeRail({
  asstMsg,
  skillName,
  parsedPayload,
}: {
  asstMsg: SessionMessage
  skillName: string
  parsedPayload: ParsedSkillPayload
}) {
  return (
    <div className="skill-exchange-rail">
      <div className="skill-exchange-step">
        <span className="skill-exchange-step-label">Request</span>
        <div className="skill-exchange-step-body tool-calls-wrap">
          <ToolCallsList toolCalls={asstMsg.toolCalls ?? []} verbose={false} />
        </div>
      </div>
      <div className="skill-exchange-step skill-exchange-step-main">
        <span className="skill-exchange-step-label">Injected</span>
        <SkillPayloadDisplay
          adjacentSkillName={skillName}
          parsedSkillPayload={parsedPayload}
          showNameHeader={false}
        />
      </div>
    </div>
  )
}

function SkillExchangeRow({
  userGroup,
  assistantGroup,
  sorted,
  msgKey,
  newKeys,
  parsedPayload,
}: {
  userGroup: GroupedSessionMessage
  assistantGroup: GroupedSessionMessage
  sorted: SessionMessage[]
  msgKey?: MessagesProps["msgKey"]
  newKeys?: Set<string>
  parsedPayload: ParsedSkillPayload
}): React.ReactElement {
  const userMsg = userGroup.message
  const asstMsg = assistantGroup.message
  const skillName = skillNameFromMessage(asstMsg) ?? "skill"

  const userKeys = groupKeysForGrouped(userGroup, sorted, msgKey, "skill-u")
  const asstKeys = groupKeysForGrouped(assistantGroup, sorted, msgKey, "skill-a")
  const isNew = [...userKeys, ...asstKeys].some((k) => newKeys?.has(k) ?? false)

  const { assistantTime, userTime } = formatTimesDisplay(userMsg, asstMsg)
  const repeatLabel = buildRepeatLabel(userGroup.count, assistantGroup.count)

  return (
    <li className={cn("message-row message-row-skill-exchange user", isNew && "message-new")}>
      <SkillExchangeMetadata
        skillName={skillName}
        repeatLabel={repeatLabel}
        assistantTime={assistantTime}
        userTime={userTime}
        userMsg={userMsg}
        asstMsg={asstMsg}
      />
      <SkillExchangeRail asstMsg={asstMsg} skillName={skillName} parsedPayload={parsedPayload} />
    </li>
  )
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
  const listItems = useMemo(() => {
    const rows: ReactNode[] = []
    for (let i = 0; i < grouped.length; i++) {
      const merged = skillExchangeMergeAt(grouped, i)
      if (merged) {
        const userKeys = groupKeysForGrouped(merged.user, sorted, msgKey, "skill-u")
        const listKey = userKeys[0]!
        const parsedPayload = parseSkillPayload(merged.user.message.text ?? "")!
        rows.push(
          <SkillExchangeRow
            key={listKey}
            assistantGroup={merged.assistant}
            newKeys={newKeys}
            parsedPayload={parsedPayload}
            sorted={sorted}
            userGroup={merged.user}
            msgKey={msgKey}
          />
        )
        i += 1
        continue
      }
      const { key, ...rowProps } = resolveMessageRowProps(grouped, sorted, i, msgKey, newKeys)
      rows.push(<MessageRow key={key} {...rowProps} />)
    }
    return rows
  }, [grouped, sorted, msgKey, newKeys])

  if (loading) {
    return <output className="empty p-8 text-center text-zinc-500">Loading transcript…</output>
  }
  if (messages.length === 0) {
    return <p className="empty p-8 text-center text-zinc-500">No messages for this session.</p>
  }

  return (
    <ul
      className="messages-list flex-1 pb-16"
      aria-label={`Latest ${SESSION_MESSAGE_LIMIT} transcript messages`}
    >
      {listItems}
    </ul>
  )
}

// eslint-disable-next-line complexity -- optional diagnostic props are intentionally independent
function SessionStatsBar({
  events,
  cacheStatus,
  activeSession,
  activeHookDispatches,
  messages,
  toolStats,
  sessionTokenStats,
  monitorMetric,
}: Pick<
  MessagesProps,
  | "events"
  | "cacheStatus"
  | "activeSession"
  | "activeHookDispatches"
  | "messages"
  | "toolStats"
  | "sessionTokenStats"
  | "monitorMetric"
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
      sessionTokenStats={sessionTokenStats ?? null}
      monitorMetric={monitorMetric ?? null}
    />
  )
}

function handleTranscriptKeyDown(event: KeyboardEvent<HTMLElement>): void {
  if (event.target !== event.currentTarget) return
  const region = event.currentTarget
  const lineStep = 40
  const pageStep = Math.max(80, Math.round(region.clientHeight * 0.8))
  const maxScroll = Math.max(0, region.scrollHeight - region.clientHeight)
  let nextScroll: number | null = null

  switch (event.key) {
    case "ArrowDown":
      nextScroll = Math.min(maxScroll, region.scrollTop + lineStep)
      break
    case "ArrowUp":
      nextScroll = Math.max(0, region.scrollTop - lineStep)
      break
    case "PageDown":
      nextScroll = Math.min(maxScroll, region.scrollTop + pageStep)
      break
    case "PageUp":
      nextScroll = Math.max(0, region.scrollTop - pageStep)
      break
    case "Home":
      nextScroll = 0
      break
    case "End":
      nextScroll = maxScroll
      break
    default:
      return
  }

  event.preventDefault()
  region.scrollTo({ top: nextScroll })
}

export function SessionMessages(props: MessagesProps): ReactElement {
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
    <section
      className={cn("card bento-messages flex flex-col h-full max-h-full", props.className)}
      aria-labelledby="transcript-title"
      aria-busy={loading}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: This named region is an independent desktop scroller and needs a keyboard entry point.
      tabIndex={0}
      onKeyDown={handleTranscriptKeyDown}
    >
      <header className="messages-header-row">
        <h2 id="transcript-title" className="section-title">
          Transcript
        </h2>
        <p className="section-subtitle">Conversation history for selected session</p>
      </header>
      <SessionStatsBar {...props} />
      {!props.hideTasks && (
        <>
          <ProjectTasksSection
            tasks={projectTasks}
            summary={projectTaskSummary}
            loading={projectTasksLoading}
          />
          <SessionTasksSection tasks={tasks} summary={taskSummary} loading={tasksLoading} />
        </>
      )}
      {toolStats && toolStats.length > 0 && <ToolStatsBar stats={toolStats} />}
      <MessagesContent
        messages={messages}
        loading={loading}
        newKeys={newKeys}
        msgKey={msgKey}
        grouped={grouped}
        sorted={sorted}
      />
    </section>
  )
}
