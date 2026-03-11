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
    <>
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
      </header>
    </>
  )
}
