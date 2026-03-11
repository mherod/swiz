function metric(label: string, value: string): string {
  return `
    <article class="metric">
      <span class="metric-label">${label}</span>
      <strong class="metric-value">${value}</strong>
    </article>
  `
}

export function StatGrid({
  uptime = "unknown",
  totalDispatches = 0,
  projects = 0,
  activeWatches = 0,
}: {
  uptime?: string
  totalDispatches?: number
  projects?: number
  activeWatches?: number
} = {}): string {
  return `
    <section class="card section overview">
      <div class="section-title-row">
        <h2>Overview</h2>
        <span class="section-subtitle">Current process snapshot</span>
      </div>
      <div class="metric-grid">
        ${metric("Uptime", uptime)}
        ${metric("Dispatches", String(totalDispatches))}
        ${metric("Projects", String(projects))}
        ${metric("CI Watches", String(activeWatches))}
      </div>
    </section>
  `
}
