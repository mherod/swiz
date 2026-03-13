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
    <section className="card bento-messages flex flex-col h-full max-h-full overflow-hidden">
      <div className="messages-header-row flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6 shrink-0">
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
        <p className="empty p-8 text-center text-zinc-500">Loading...</p>
      ) : messages.length === 0 ? (
        <p className="empty p-8 text-center text-zinc-500">No messages for this session.</p>
      ) : (
        <ul
          className="messages-list overflow-y-auto flex-1 pb-16"
          aria-label="Last 30 transcript messages"
        >
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
