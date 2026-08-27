import { type ReactElement, useMemo } from "react"
import { formatLastActivity } from "../lib/dashboard-helpers.ts"
import type { ActiveHookDispatch, SessionTokenStats } from "../lib/dashboard-hooks.ts"
import { NumberTicker } from "./number-ticker.tsx"
import type { ToolStat } from "./session-browser.tsx"
import type { SessionHealth } from "./session-browser-types.ts"
import { isInternalToolName } from "./session-browser-utils.ts"

interface EventMetric {
  name: string
  count: number
  avgMs: number
  routes?: Record<
    string,
    { count?: number; stages?: Record<string, { avgMs?: number; count?: number }> }
  >
}

interface MonitorMetric {
  count?: number
  avgMs?: number
  p95Ms?: number
}

function CompactMetricValue({ value }: { value: number }) {
  const exact = value.toLocaleString()
  const compact = new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value)
  return <strong title={exact}>{compact}</strong>
}

interface CacheSummary {
  snapshotCacheSize?: number
  ghCacheSize?: number
  eligibilityCacheSize?: number
  transcriptIndexSize?: number
  cooldownRegistrySize?: number
  gitStateCacheSize?: number
  projectSettingsCacheSize?: number
  manifestCacheSize?: number
}

interface ProjectPerformanceStatsProps {
  totalDispatches: number
  avgLatency: number
  hottestEvent: string
  hookRuntimeMs: number
  monitor?: MonitorMetric
}

type DiagnosticRoute = NonNullable<EventMetric["routes"]>[string]

function hookStageMetric(route: DiagnosticRoute, stage: "syncHooks" | "asyncHooks") {
  const metric = route.stages?.[stage]
  return { avgMs: metric?.avgMs ?? 0, count: metric?.count ?? 0 }
}

function routeHookWallTime(route: DiagnosticRoute): number {
  const syncHooks = hookStageMetric(route, "syncHooks")
  const asyncHooks = hookStageMetric(route, "asyncHooks")
  const wallTime = Math.max(syncHooks.avgMs, asyncHooks.avgMs)
  const sampleCount = Math.max(syncHooks.count, asyncHooks.count) || route.count || 0
  return wallTime * sampleCount
}

export function calculateHookWallTimeMs(events: EventMetric[]): number {
  const totalDispatches = events.reduce((total, event) => total + event.count, 0)
  if (totalDispatches === 0) return 0

  const totalHookWallTime = events.reduce(
    (total, event) =>
      total +
      Object.values(event.routes ?? {}).reduce(
        (routeTotal, route) => routeTotal + routeHookWallTime(route),
        0
      ),
    0
  )

  return Math.round(totalHookWallTime / totalDispatches)
}

export function formatDiagnosticDuration(value: number | undefined, sampleCount: number): string {
  if (sampleCount <= 0 || value === undefined || !Number.isFinite(value)) return "Not recorded"
  if (value === 0) return "<1 ms"
  if (value < 1) return `${value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")} ms`
  return `${Math.round(value)} ms`
}

function ProjectMetricExplainers({ hasMonitorSamples }: { hasMonitorSamples: boolean }) {
  return (
    <dl className="metric-explainers">
      <div>
        <dt>Dispatch activity</dt>
        <dd>Project dispatches since daemon start, weighted response time, and busiest event.</dd>
      </div>
      <div>
        <dt>Hook wall time</dt>
        <dd>Average time occupied by concurrent hook stages across all project dispatches.</dd>
      </div>
      {hasMonitorSamples ? (
        <div>
          <dt>Transcript monitor</dt>
          <dd>Average scan duration and the threshold containing 95% of observed scans.</dd>
        </div>
      ) : null}
    </dl>
  )
}

function ProjectDiagnosticOverview({
  totalDispatches,
  avgLatency,
  hottestEvent,
}: Pick<ProjectPerformanceStatsProps, "totalDispatches" | "avgLatency" | "hottestEvent">) {
  return (
    <div className="project-diagnostic-overview">
      <span className="project-diagnostic-metric">
        <strong>
          <NumberTicker value={totalDispatches} />
        </strong>
        <span>Project dispatches</span>
      </span>
      <span className="project-diagnostic-metric">
        <strong>
          <NumberTicker value={avgLatency} /> ms
        </strong>
        <span>Average response</span>
      </span>
      {hottestEvent !== "n/a" ? (
        <span className="project-diagnostic-metric">
          <strong>{hottestEvent}</strong>
          <span>Busiest event</span>
        </span>
      ) : null}
    </div>
  )
}

function ProjectTimingBreakdown({
  hookRuntimeMs,
  monitor,
}: Pick<ProjectPerformanceStatsProps, "hookRuntimeMs" | "monitor">) {
  const monitorSamples = monitor?.count ?? 0
  return (
    <div className="project-diagnostic-timings">
      <span className="project-diagnostic-timing">
        <span>Hook wall time</span>
        <strong>{hookRuntimeMs} ms</strong>
      </span>
      {monitorSamples > 0 ? (
        <>
          <span className="project-diagnostic-timing">
            <span>Monitor average</span>
            <strong>{formatDiagnosticDuration(monitor?.avgMs, monitorSamples)}</strong>
          </span>
          <span className="project-diagnostic-timing">
            <span>Monitor p95</span>
            <strong>{formatDiagnosticDuration(monitor?.p95Ms, monitorSamples)}</strong>
          </span>
        </>
      ) : (
        <span className="project-diagnostic-monitor-empty">No transcript scans recorded yet.</span>
      )}
    </div>
  )
}

function ProjectPerformanceStats(props: ProjectPerformanceStatsProps) {
  return (
    <>
      <p className="project-diagnostic-scope">Current project · Since daemon started</p>
      <ProjectDiagnosticOverview {...props} />
      <ProjectTimingBreakdown {...props} />
      <ProjectMetricExplainers hasMonitorSamples={(props.monitor?.count ?? 0) > 0} />
    </>
  )
}

interface CurrentSessionStatsProps {
  activeSession: SessionHealth | null
  loadedMessageCount: number
  totalToolCalls: number
  activeDispatch: ActiveHookDispatch | null
  activeRuntimeSeconds: number
}

function SessionActivityTime({ value }: { value: number | null }) {
  if (value === null || !Number.isFinite(value)) return <>Unknown</>
  const date = new Date(value)
  return (
    <time dateTime={date.toISOString()} title={date.toLocaleString()}>
      {formatLastActivity(value)}
    </time>
  )
}

function SessionKpis({
  activeSession,
  loadedMessageCount,
  totalToolCalls,
}: {
  activeSession: CurrentSessionStatsProps["activeSession"]
  loadedMessageCount: number
  totalToolCalls: number
}) {
  return (
    <div className="metric-kpis session-metric-kpis">
      <span className="metric-kpi session-metric-kpi">
        <strong>
          <NumberTicker value={activeSession?.dispatches ?? 0} />
        </strong>
        <span className="session-metric-label">Dispatches</span>
      </span>
      <span className="metric-kpi session-metric-kpi">
        <strong>
          <NumberTicker value={loadedMessageCount} />
        </strong>
        <span className="session-metric-label">Messages loaded</span>
      </span>
      <span className="metric-kpi session-metric-kpi">
        <strong>
          <NumberTicker value={totalToolCalls} />
        </strong>
        <span className="session-metric-label">Tool calls</span>
      </span>
    </div>
  )
}

function ActiveDispatchBadge({
  activeDispatch,
  activeRuntimeSeconds,
}: {
  activeDispatch: ActiveHookDispatch
  activeRuntimeSeconds: number
}) {
  return (
    <div className="stats-active-badge">
      <span className="session-active-pulse" />
      <span className="stats-active-text">
        {activeDispatch.toolName ? (
          <>
            Running <strong>{activeDispatch.toolName}</strong>
          </>
        ) : (
          <>
            Processing <strong>{activeDispatch.canonicalEvent}</strong>
          </>
        )}
        <span className="stats-active-time"> · {activeRuntimeSeconds}s</span>
      </span>
    </div>
  )
}

function CurrentSessionStats({
  activeSession,
  loadedMessageCount,
  totalToolCalls,
  activeDispatch,
  activeRuntimeSeconds,
}: CurrentSessionStatsProps) {
  return (
    <>
      <SessionKpis
        activeSession={activeSession}
        loadedMessageCount={loadedMessageCount}
        totalToolCalls={totalToolCalls}
      />
      {activeDispatch && (
        <ActiveDispatchBadge
          activeDispatch={activeDispatch}
          activeRuntimeSeconds={activeRuntimeSeconds}
        />
      )}
      <p className="metric-note session-last-activity">
        Last session activity{" "}
        <SessionActivityTime value={activeSession?.lastMessageAt ?? activeSession?.mtime ?? null} />
      </p>
    </>
  )
}

// eslint-disable-next-line max-lines-per-function -- compact diagnostics composition stays readable as one panel
export function DashboardStats({
  events = [],
  cache: _cache = {},
  activeSession,
  activeHookDispatches,
  loadedMessageCount,
  sessionToolStats,
  sessionTokenStats,
  monitorMetric,
}: {
  events?: EventMetric[]
  cache?: CacheSummary
  activeSession: SessionHealth | null
  activeHookDispatches: ActiveHookDispatch[]
  loadedMessageCount: number
  sessionToolStats: ToolStat[]
  sessionTokenStats?: SessionTokenStats | null
  monitorMetric?: MonitorMetric | null
}): ReactElement {
  // Performance logic
  const totalDispatches = useMemo(
    () => events.reduce((sum, event) => sum + event.count, 0),
    [events]
  )
  const avgLatency = useMemo(
    () =>
      totalDispatches > 0
        ? Math.round(
            events.reduce((sum, event) => sum + event.avgMs * event.count, 0) / totalDispatches
          )
        : 0,
    [events, totalDispatches]
  )
  const hottestEvent = events[0]?.name ?? "n/a"
  const hookRuntimeMs = useMemo(() => calculateHookWallTimeMs(events), [events])

  // Session logic
  const visibleToolStats = sessionToolStats.filter((stat) => !isInternalToolName(stat.name))
  const activeDispatch = activeHookDispatches[0] ?? null
  const totalToolCalls = visibleToolStats.reduce((sum, stat) => sum + stat.count, 0)
  const activeRuntimeSeconds = activeDispatch
    ? Math.max(0, Math.round((Date.now() - activeDispatch.startedAt) / 1000))
    : 0

  return (
    <div className="stats-grid">
      <div className="stats-group">
        <h3 className="stats-group-title">Current session</h3>
        <CurrentSessionStats
          activeSession={activeSession}
          loadedMessageCount={loadedMessageCount}
          totalToolCalls={totalToolCalls}
          activeDispatch={activeDispatch}
          activeRuntimeSeconds={activeRuntimeSeconds}
        />
        {sessionTokenStats && (
          <div
            className="diagnostic-breakdown session-token-stats"
            title="Cumulative processed tokens and generated-token rate from this session transcript"
          >
            <span>
              <CompactMetricValue value={sessionTokenStats.totalTokens} /> processed
            </span>
            <span>
              <strong>
                <NumberTicker value={sessionTokenStats.outputTokensPerMinute} />
              </strong>{" "}
              output tok/min
            </span>
            <span>
              <CompactMetricValue value={sessionTokenStats.outputTokens} /> generated
            </span>
          </div>
        )}
        <details className="stats-help">
          <summary>How these numbers work</summary>
          <p>
            Tool calls are session-wide; the transcript below shows the latest bounded message
            window.
          </p>
          {sessionTokenStats ? (
            <p>
              Processed includes repeatedly reused cached input. Output tok/min is generated-token
              growth between the first and latest session telemetry samples; generated is cumulative
              output only.
            </p>
          ) : null}
        </details>
      </div>
      <details className="stats-diagnostics">
        <summary>
          <span>Project diagnostics</span>
          <span className="stats-diagnostics-hint">Dispatch timing and hook performance</span>
        </summary>
        <div className="stats-diagnostics-content">
          <ProjectPerformanceStats
            totalDispatches={totalDispatches}
            avgLatency={avgLatency}
            hottestEvent={hottestEvent}
            hookRuntimeMs={hookRuntimeMs}
            monitor={monitorMetric ?? undefined}
          />
        </div>
      </details>
    </div>
  )
}
