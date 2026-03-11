interface HeaderProps {
  lastUpdated: string
  uptime: string
  totalDispatches: number
  projects: number
  activeWatches: number
}

export function Header({
  lastUpdated,
  uptime,
  totalDispatches,
  projects,
  activeWatches,
}: HeaderProps) {
  return (
    <header className="topbar">
      <h1 className="topbar-title">swiz daemon</h1>
      <div className="topbar-stats">
        <span className="topbar-stat">
          <strong>{uptime}</strong> uptime
        </span>
        <span className="topbar-stat">
          <strong>{totalDispatches}</strong> dispatches
        </span>
        <span className="topbar-stat">
          <strong>{projects}</strong> projects
        </span>
        <span className="topbar-stat">
          <strong>{activeWatches}</strong> CI watches
        </span>
      </div>
      <div className="topbar-right">
        <output className="status-pill" aria-label="Daemon status is live">
          <span className="status-dot" aria-hidden="true" />
          <span>Live</span>
        </output>
        <span className="topbar-meta">Updated {lastUpdated}</span>
      </div>
    </header>
  )
}
