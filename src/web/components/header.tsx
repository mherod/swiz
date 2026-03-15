import type { ActiveView } from "../lib/dashboard-state.ts"
import { NumberTicker } from "./number-ticker.tsx"

interface HeaderProps {
  lastUpdated: string
  uptime: string
  totalDispatches: number
  projects: number
  activeWatches: number
  activeHooks: number
  selectedProjectName: string | null
  activeView?: ActiveView
  onSelectView?: (view: ActiveView) => void
  cacheStatus?: Record<string, number> | null
  activeAgentProcessProviders?: Record<string, number[]>
}

const CACHE_LABELS: Array<{ label: string; key: string }> = [
  { label: "Snapshots", key: "snapshotCacheSize" },
  { label: "GitHub", key: "ghCacheSize" },
  { label: "Eligibility", key: "eligibilityCacheSize" },
  { label: "Transcripts", key: "transcriptIndexSize" },
  { label: "Cooldown", key: "cooldownRegistrySize" },
  { label: "Git state", key: "gitStateCacheSize" },
  { label: "Settings", key: "projectSettingsCacheSize" },
  { label: "Manifest", key: "manifestCacheSize" },
]

function buildCacheEntries(cacheStatus: Record<string, number> | null | undefined) {
  if (!cacheStatus) return { totalCacheEntries: 0, warmCaches: 0 }
  let total = 0
  let warm = 0
  for (const { key } of CACHE_LABELS) {
    const v = cacheStatus[key] ?? 0
    total += v
    if (v > 0) warm++
  }
  return { totalCacheEntries: total, warmCaches: warm }
}

function ViewToggleButton({
  label,
  active,
  onClick,
}: {
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        background: active ? "rgba(110, 147, 223, 0.38)" : "transparent",
        color: active ? "#fff" : "#a8bee8",
        border: "none",
        padding: "4px 12px",
        borderRadius: "4px",
        fontSize: "0.75rem",
        cursor: "pointer",
        fontWeight: active ? "600" : "400",
        transition: "all 0.15s ease",
      }}
    >
      {label}
    </button>
  )
}

const TAB_LABELS: Array<{ view: ActiveView; label: string }> = [
  { view: "dashboard", label: "Dashboard" },
  { view: "issues", label: "Issues" },
  { view: "tasks", label: "Tasks" },
  { view: "transcript", label: "Transcript" },
  { view: "settings", label: "Project Settings" },
]

export function Header({
  lastUpdated,
  uptime,
  totalDispatches,
  projects,
  activeWatches,
  activeHooks,
  selectedProjectName,
  activeView = "dashboard",
  onSelectView,
  cacheStatus,
  activeAgentProcessProviders = {},
}: HeaderProps) {
  const { totalCacheEntries, warmCaches } = buildCacheEntries(cacheStatus)

  const totalRunningAgents = Object.values(activeAgentProcessProviders).reduce(
    (sum, pids) => sum + pids.length,
    0
  )

  const isActive = totalRunningAgents > 0 || activeHooks > 0
  const mascotSrc = isActive ? "/public/swiz-buzz-animated.svg" : "/public/swiz-buzz-flat.svg"

  return (
    <header className="bento-title">
      <div
        className="title-row"
        style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <img src={mascotSrc} alt="swiz" style={{ height: "32px", width: "auto" }} />
          <h1 className="topbar-title">swiz daemon</h1>
          <output className="status-pill">
            <span className="status-dot" aria-hidden="true" />
            <span>Live</span>
          </output>
        </div>

        {onSelectView && (
          <div
            className="view-toggle"
            style={{
              display: "flex",
              background: "rgba(35, 58, 104, 0.25)",
              borderRadius: "6px",
              padding: "2px",
              border: "1px solid rgba(110, 147, 223, 0.38)",
            }}
          >
            {TAB_LABELS.map(({ view, label }) => (
              <ViewToggleButton
                key={view}
                label={label}
                active={activeView === view}
                onClick={() => onSelectView(view)}
              />
            ))}
          </div>
        )}
      </div>
      <span className="topbar-meta">Updated {lastUpdated}</span>
      <p className="topbar-summary">
        {uptime} uptime · <NumberTicker value={totalDispatches} /> dispatches ·{" "}
        <NumberTicker value={projects} /> active projects · <NumberTicker value={activeWatches} />{" "}
        CI watches
      </p>
      <div className="header-chips">
        <span className="header-chip">
          <strong>
            <NumberTicker value={activeHooks} />
          </strong>{" "}
          active hooks
        </span>
        <span className="header-chip">
          <strong>
            <NumberTicker value={totalRunningAgents} />
          </strong>{" "}
          running agents
        </span>
        <span className="header-chip">
          project: <strong>{selectedProjectName ?? "none"}</strong>
        </span>
        {totalCacheEntries > 0 && (
          <span className="header-chip">
            daemon caches:{" "}
            <strong>
              <NumberTicker value={warmCaches} />
            </strong>{" "}
            warm /{" "}
            <strong>
              <NumberTicker value={totalCacheEntries} />
            </strong>{" "}
            total
          </span>
        )}
      </div>
    </header>
  )
}
