import { type KeyboardEvent, type ReactElement, useCallback, useEffect, useState } from "react"
import type { HookLogEntry } from "../../../hook-log.ts"

const STATUS_COLORS: Record<string, string> = {
  ok: "log-status-ok",
  deny: "log-status-deny",
  block: "log-status-deny",
  "allow-with-reason": "log-status-ok",
  "no-output": "log-status-skip",
  "no-hooks": "log-status-skip",
  skipped: "log-status-skip",
  timeout: "log-status-error",
  error: "log-status-error",
  "invalid-json": "log-status-error",
  slow: "log-status-warn",
}

const STATUS_ICONS: Record<string, string> = {
  ok: "✓",
  "allow-with-reason": "✓",
  skipped: "○",
  "no-output": "○",
  "no-hooks": "○",
  slow: "⚠",
  timeout: "⚠",
  deny: "×",
  block: "×",
  error: "×",
  "invalid-json": "×",
}

type SortDirection = "asc" | "desc"
type LogSortKey = "time" | "event" | "hook" | "status" | "duration" | "tool"

interface LogSort {
  key: LogSortKey
  direction: SortDirection
}

const LOG_COLUMNS: Array<{ key: LogSortKey; label: string }> = [
  { key: "time", label: "Time" },
  { key: "event", label: "Event" },
  { key: "status", label: "Status" },
  { key: "duration", label: "Duration" },
  { key: "hook", label: "Hook" },
  { key: "tool", label: "Tool" },
]

function formatTime(ts: string): string {
  try {
    return new Date(ts).toLocaleTimeString(undefined, { hour12: false })
  } catch {
    return ts
  }
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`
}

function hookBasename(hook: string): string {
  const parts = hook.split("/")
  return parts[parts.length - 1] ?? hook
}

function statusLabel(status: string): string {
  const icon = STATUS_ICONS[status]
  return icon ? `${icon} ${status}` : status
}

function sortValue(entry: HookLogEntry, key: LogSortKey): string | number {
  if (key === "time") return Date.parse(entry.ts) || 0
  if (key === "duration") return entry.durationMs
  if (key === "tool") return entry.toolName ?? ""
  return entry[key]
}

function sortEntries(entries: HookLogEntry[], sort: LogSort): HookLogEntry[] {
  const direction = sort.direction === "asc" ? 1 : -1
  return [...entries].sort((a, b) => {
    const av = sortValue(a, sort.key)
    const bv = sortValue(b, sort.key)
    if (typeof av === "number" && typeof bv === "number") return (av - bv) * direction
    return String(av).localeCompare(String(bv)) * direction
  })
}

function LogDetailContent({ entry }: { entry: HookLogEntry }) {
  return (
    <>
      {entry.matcher ? (
        <p>
          <strong>Matcher:</strong> {entry.matcher}
        </p>
      ) : null}
      {entry.sessionId ? (
        <p>
          <strong>Session:</strong> <code>{entry.sessionId.slice(0, 12)}</code>
        </p>
      ) : null}
      {entry.cwd ? (
        <p>
          <strong>CWD:</strong> <code>{entry.cwd}</code>
        </p>
      ) : null}
      {entry.exitCode !== null && entry.exitCode !== 0 ? (
        <p>
          <strong>Exit code:</strong> {entry.exitCode}
        </p>
      ) : null}
      {entry.stdoutSnippet ? (
        <details>
          <summary>stdout</summary>
          <pre className="log-snippet">{entry.stdoutSnippet}</pre>
        </details>
      ) : null}
      {entry.stderrSnippet ? (
        <details>
          <summary>stderr</summary>
          <pre className="log-snippet">{entry.stderrSnippet}</pre>
        </details>
      ) : null}
    </>
  )
}

function LogRow({
  entry,
  expanded,
  onToggle,
}: {
  entry: HookLogEntry
  expanded: boolean
  onToggle: () => void
}) {
  const isDispatch = entry.kind === "dispatch"
  const rowClass = isDispatch ? "log-row log-row-dispatch" : "log-row"
  const handleKeyDown = (event: KeyboardEvent<HTMLTableRowElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return
    event.preventDefault()
    onToggle()
  }
  return (
    <>
      <tr
        className={rowClass}
        onClick={onToggle}
        onKeyDown={handleKeyDown}
        tabIndex={0}
        aria-expanded={expanded}
      >
        <td className="log-cell log-cell-time">{formatTime(entry.ts)}</td>
        <td className="log-cell log-cell-event">{entry.event}</td>
        <td className={`log-cell log-cell-status ${STATUS_COLORS[entry.status] ?? ""}`}>
          {statusLabel(entry.status)}
          {entry.skipReason ? <span className="log-skip-reason"> ({entry.skipReason})</span> : null}
        </td>
        <td className="log-cell log-cell-duration">{formatDuration(entry.durationMs)}</td>
        <td className="log-cell log-cell-hook" title={entry.hook} aria-label={`Hook ${entry.hook}`}>
          {isDispatch ? (
            <span className="log-dispatch-label">
              dispatch
              {typeof entry.hookCount === "number" ? (
                <span className="log-hook-count">
                  {" "}
                  ({entry.hookCount} hook{entry.hookCount === 1 ? "" : "s"})
                </span>
              ) : null}
            </span>
          ) : (
            hookBasename(entry.hook)
          )}
        </td>
        <td className="log-cell log-cell-tool">{entry.toolName ?? ""}</td>
      </tr>
      {expanded ? (
        <tr className="log-row-detail">
          <td colSpan={6} className="log-detail">
            <LogDetailContent entry={entry} />
          </td>
        </tr>
      ) : null}
    </>
  )
}

function LogTable({
  entries,
  expandedIdx,
  onToggle,
  sort,
  onSort,
}: {
  entries: HookLogEntry[]
  expandedIdx: number | null
  onToggle: (i: number) => void
  sort: LogSort
  onSort: (key: LogSortKey) => void
}) {
  return (
    <div className="logs-table-wrap">
      <table className="logs-table">
        <thead>
          <tr>
            {LOG_COLUMNS.map((column) => {
              const active = sort.key === column.key
              return (
                <th
                  key={column.key}
                  aria-sort={
                    active ? (sort.direction === "asc" ? "ascending" : "descending") : "none"
                  }
                >
                  <button
                    type="button"
                    className="log-sort-button"
                    onClick={() => onSort(column.key)}
                    aria-label={`Sort logs by ${column.label}`}
                  >
                    <span>{column.label}</span>
                    <span aria-hidden="true" className="log-sort-indicator">
                      {active ? (sort.direction === "asc" ? "▲" : "▼") : "↕"}
                    </span>
                  </button>
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody>
          {entries.map((entry, i) => (
            <LogRow
              key={`${entry.ts}-${entry.hook}-${entry.event}-${entry.durationMs}`}
              entry={entry}
              expanded={expandedIdx === i}
              onToggle={() => onToggle(i)}
            />
          ))}
        </tbody>
      </table>
    </div>
  )
}

function useHookLogs() {
  const [entries, setEntries] = useState<HookLogEntry[]>([])
  const [loading, setLoading] = useState(true)

  const fetchLogs = useCallback(async () => {
    try {
      const res = await fetch("/api/hook-logs?limit=300")
      if (!res.ok) return
      const data = (await res.json()) as { entries: HookLogEntry[] }
      setEntries(data.entries)
    } catch {
      // Retry on next interval
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void fetchLogs()
    const interval = setInterval(() => void fetchLogs(), 5000)
    return () => clearInterval(interval)
  }, [fetchLogs])

  return { entries, loading, fetchLogs }
}

function filterEntries(
  entries: HookLogEntry[],
  filter: string,
  hideSkipped: boolean
): HookLogEntry[] {
  let result = entries
  if (hideSkipped) {
    result = result.filter((e) => e.status !== "skipped")
  }
  if (!filter) return result
  return result.filter(
    (e) =>
      e.event.includes(filter) ||
      e.hook.includes(filter) ||
      e.status.includes(filter) ||
      (e.skipReason ?? "").includes(filter) ||
      (e.toolName ?? "").includes(filter)
  )
}

export function LogsView(): ReactElement {
  const { entries, loading, fetchLogs } = useHookLogs()
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null)
  const [filter, setFilter] = useState("")
  const [hideSkipped, setHideSkipped] = useState(true)
  const [sort, setSort] = useState<LogSort>({ key: "time", direction: "desc" })

  const filtered = filterEntries(entries, filter, hideSkipped)
  const sorted = sortEntries(filtered, sort)

  const handleSort = (key: LogSortKey) => {
    setExpandedIdx(null)
    setSort((current) =>
      current.key === key
        ? { key, direction: current.direction === "asc" ? "desc" : "asc" }
        : { key, direction: key === "duration" ? "desc" : "asc" }
    )
  }

  return (
    <div className="bento-full-page">
      <section className="card logs-panel">
        <div className="logs-header">
          <h2>Hook Dispatch Logs</h2>
          <input
            type="text"
            className="logs-filter"
            placeholder="Filter by event, hook, status, tool\u2026"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <label className="logs-toggle">
            <input
              type="checkbox"
              checked={hideSkipped}
              onChange={(e) => setHideSkipped(e.target.checked)}
            />
            Hide skipped
          </label>
          <button type="button" className="logs-refresh" onClick={() => void fetchLogs()}>
            Refresh
          </button>
        </div>
        {loading ? (
          <p className="logs-loading">Loading logs\u2026</p>
        ) : sorted.length === 0 ? (
          <p className="logs-empty">No log entries{filter ? " matching filter" : ""}.</p>
        ) : (
          <LogTable
            entries={sorted}
            expandedIdx={expandedIdx}
            onToggle={(i) => setExpandedIdx(expandedIdx === i ? null : i)}
            sort={sort}
            onSort={handleSort}
          />
        )}
      </section>
    </div>
  )
}
