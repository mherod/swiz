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
  routes?: Record<string, { count?: number; stages?: Record<string, { avgMs?: number }> }>
}

interface MonitorMetric {
  count?: number
  avgMs?: number
  p95Ms?: number
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

function ProjectMetricExplainers() {
  return (
    <dl className="metric-explainers">
      <div>
        <dt>Total / avg / hottest</dt>
        <dd>Project dispatches since daemon start, weighted mean latency, and most-used event.</dd>
      </div>
      <div>
        <dt>Hooks avg</dt>
        <dd>Dispatch-weighted time spent inside synchronous and asynchronous Swiz hooks.</dd>
      </div>
      <div>
        <dt>Monitor avg / p95</dt>
        <dd>Transcript scan duration; p95 is the slow-end threshold for 95% of scans.</dd>
      </div>
    </dl>
  )
}

function ProjectPerformanceStats({
  totalDispatches,
  avgLatency,
  hottestEvent,
  hookRuntimeMs,
  monitor,
}: ProjectPerformanceStatsProps) {
  return (
    <>
      <div className="metric-kpis">
        {totalDispatches > 0 && (
          <span className="metric-kpi">
            <strong>
              <NumberTicker value={totalDispatches} />
            </strong>{" "}
            total
          </span>
        )}
        {avgLatency > 0 && (
          <span className="metric-kpi">
            <strong>
              <NumberTicker value={avgLatency} />
              ms
            </strong>{" "}
            avg
          </span>
        )}
        {hottestEvent !== "n/a" && (
          <span className="metric-kpi">
            <strong>{hottestEvent}</strong> hottest
          </span>
        )}
      </div>
      <p className="metric-note">Performance metrics for the current project scope.</p>
      <div className="diagnostic-breakdown" title="Bounded daemon timing samples">
        <span>
          <strong>{hookRuntimeMs}ms</strong> hooks avg
        </span>
        <span>
          <strong>{Math.round(monitor?.avgMs ?? 0)}ms</strong> monitor avg
        </span>
        <span>
          <strong>{Math.round(monitor?.p95Ms ?? 0)}ms</strong> monitor p95
        </span>
      </div>
      <ProjectMetricExplainers />
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
    <div className="metric-kpis">
      {(activeSession?.dispatches ?? 0) > 0 && (
        <span className="metric-kpi">
          <strong>
            <NumberTicker value={activeSession?.dispatches ?? 0} />
          </strong>{" "}
          dispatches
        </span>
      )}
      {loadedMessageCount > 0 && (
        <span className="metric-kpi">
          <strong>
            <NumberTicker value={loadedMessageCount} />
          </strong>{" "}
          messages
        </span>
      )}
      {totalToolCalls > 0 && (
        <span className="metric-kpi">
          <strong>
            <NumberTicker value={totalToolCalls} />
          </strong>{" "}
          tool calls
        </span>
      )}
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
      <p className="metric-note">
        Last activity:{" "}
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
  const hookRuntimeMs = useMemo(
    () =>
      Math.round(
        events.reduce((sum, event) => {
          const stages = event.routes
          return (
            sum +
            Object.values(stages ?? {}).reduce(
              (routeSum, route) =>
                routeSum +
                ((route.stages?.syncHooks?.avgMs ?? 0) + (route.stages?.asyncHooks?.avgMs ?? 0)) *
                  (route.count ?? 0),
              0
            )
          )
        }, 0) / Math.max(totalDispatches, 1)
      ),
    [events, totalDispatches]
  )

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
          <>
            <div
              className="diagnostic-breakdown session-token-stats"
              title="Cumulative processed tokens and generated-token rate from this session transcript"
            >
              <span>
                <strong>
                  <NumberTicker value={sessionTokenStats.totalTokens} />
                </strong>{" "}
                processed
              </span>
              <span>
                <strong>
                  <NumberTicker value={sessionTokenStats.outputTokensPerMinute} />
                </strong>{" "}
                output tok/min
              </span>
              <span>
                <strong>
                  <NumberTicker value={sessionTokenStats.outputTokens} />
                </strong>{" "}
                generated
              </span>
            </div>
            <p className="metric-note metric-token-note">
              Processed includes repeatedly reused cached input. Output tok/min is generated-token
              growth between the first and latest session telemetry samples; generated is cumulative
              output only.
            </p>
          </>
        )}
      </div>
      <details className="stats-diagnostics">
        <summary>Project diagnostics</summary>
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
