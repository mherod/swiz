interface HeaderProps {
  lastUpdated: string
  uptime: string
  totalDispatches: number
  projects: number
  activeWatches: number
  activeHooks: number
  selectedProjectName: string | null
  activeView?: "dashboard" | "settings"
  onSelectView?: (view: "dashboard" | "settings") => void
  cacheStatus?: Record<string, number> | null
  activeAgentProcessProviders?: Record<string, number[]>
}

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
  // Cache logic
  const cacheEntries = cacheStatus
    ? [
        { label: "Snapshots", value: cacheStatus.snapshotCacheSize ?? 0 },
        { label: "GitHub", value: cacheStatus.ghCacheSize ?? 0 },
        { label: "Eligibility", value: cacheStatus.eligibilityCacheSize ?? 0 },
        { label: "Transcripts", value: cacheStatus.transcriptIndexSize ?? 0 },
        { label: "Cooldown", value: cacheStatus.cooldownRegistrySize ?? 0 },
        { label: "Git state", value: cacheStatus.gitStateCacheSize ?? 0 },
        { label: "Settings", value: cacheStatus.projectSettingsCacheSize ?? 0 },
        { label: "Manifest", value: cacheStatus.manifestCacheSize ?? 0 },
      ]
    : []
  const totalCacheEntries = cacheEntries.reduce((sum, item) => sum + item.value, 0)
  const warmCaches = cacheEntries.filter((item) => item.value > 0).length

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
            <button
              type="button"
              onClick={() => onSelectView("dashboard")}
              style={{
                background:
                  activeView === "dashboard" ? "rgba(110, 147, 223, 0.38)" : "transparent",
                color: activeView === "dashboard" ? "#fff" : "#a8bee8",
                border: "none",
                padding: "4px 12px",
                borderRadius: "4px",
                fontSize: "0.75rem",
                cursor: "pointer",
                fontWeight: activeView === "dashboard" ? "600" : "400",
                transition: "all 0.15s ease",
              }}
            >
              Dashboard
            </button>
            <button
              type="button"
              onClick={() => onSelectView("settings")}
              style={{
                background: activeView === "settings" ? "rgba(110, 147, 223, 0.38)" : "transparent",
                color: activeView === "settings" ? "#fff" : "#a8bee8",
                border: "none",
                padding: "4px 12px",
                borderRadius: "4px",
                fontSize: "0.75rem",
                cursor: "pointer",
                fontWeight: activeView === "settings" ? "600" : "400",
                transition: "all 0.15s ease",
              }}
            >
              Project Settings
            </button>
          </div>
        )}
      </div>
      <span className="topbar-meta">Updated {lastUpdated}</span>
      <p className="topbar-summary">
        {uptime} uptime · {totalDispatches} dispatches · {projects} active projects ·{" "}
        {activeWatches} CI watches
      </p>
      <div className="header-chips">
        <span className="header-chip">
          <strong>{activeHooks}</strong> active hooks
        </span>
        <span className="header-chip">
          <strong>{totalRunningAgents}</strong> running agents
        </span>
        <span className="header-chip">
          project: <strong>{selectedProjectName ?? "none"}</strong>
        </span>
        {totalCacheEntries > 0 && (
          <span className="header-chip">
            daemon caches: <strong>{warmCaches}</strong> warm / <strong>{totalCacheEntries}</strong>{" "}
            total
          </span>
        )}
      </div>
    </header>
  )
}
