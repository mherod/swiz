interface HeaderProps {
  lastUpdated: string
  uptime: string
  totalDispatches: number
}

export function Header({ lastUpdated, uptime, totalDispatches }: HeaderProps): string {
  return `
    <header class="card header" role="banner">
      <span class="header-glow" aria-hidden="true"></span>
      <div class="header-row">
        <div>
          <p class="eyebrow">Observability</p>
          <h1>swiz daemon</h1>
          <p>Realtime daemon status, cache health, and dispatch telemetry.</p>
        </div>
        <div class="status-pill" role="status" aria-label="Daemon status is live">
          <span class="status-dot" aria-hidden="true"></span>
          <span>Live</span>
        </div>
      </div>
      <div class="header-kpis">
        <article>
          <span>Uptime</span>
          <strong>${uptime}</strong>
        </article>
        <article>
          <span>Total Dispatches</span>
          <strong>${totalDispatches}</strong>
        </article>
      </div>
      <div class="header-meta">
        <span>Auto-refresh: every 5s</span>
        <span>Last update: ${lastUpdated}</span>
      </div>
    </header>
  `
}
