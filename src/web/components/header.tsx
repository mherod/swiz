interface HeaderProps {
  lastUpdated: string
  uptime: string
  totalDispatches: number
  projects: number
  activeWatches: number
  activeHooks: number
  selectedProjectName: string | null
}

export function Header({
  lastUpdated,
  uptime,
  totalDispatches,
  projects,
  activeWatches,
  activeHooks,
  selectedProjectName,
}: HeaderProps) {
  return (
    <header className="bento-title">
      <div className="title-row">
        <h1 className="topbar-title">swiz daemon</h1>
        <output className="status-pill">
          <span className="status-dot" aria-hidden="true" />
          <span>Live</span>
        </output>
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
          project: <strong>{selectedProjectName ?? "none"}</strong>
        </span>
      </div>
    </header>
  )
}
