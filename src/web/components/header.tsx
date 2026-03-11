interface HeaderProps {
  lastUpdated: string
  uptime: string
  totalDispatches: number
  projects: number
  activeWatches: number
}

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <article className="bento-stat">
      <span className="stat-label">{label}</span>
      <strong className="stat-value">{value}</strong>
    </article>
  )
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
          <output className="status-pill" aria-label="Daemon status is live">
            <span className="status-dot" aria-hidden="true" />
            <span>Live</span>
          </output>
        </div>
        <span className="topbar-meta">Updated {lastUpdated}</span>
      </header>
      <StatCard label="Uptime" value={uptime} />
      <StatCard label="Dispatches" value={totalDispatches} />
      <StatCard label="Projects" value={projects} />
      <StatCard label="CI Watches" value={activeWatches} />
    </>
  )
}
