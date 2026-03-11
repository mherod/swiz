interface EventMetric {
  name: string
  count: number
  avgMs: number
}

function countWidth(maxCount: number, eventCount: number): number {
  if (maxCount === 0) return 0
  return Math.round((eventCount / maxCount) * 100)
}

export function EventTable({
  events = [],
  scope = "global",
}: {
  events?: EventMetric[]
  scope?: "global" | "project"
}) {
  const maxCount = events.reduce((max, event) => Math.max(max, event.count), 0)
  const totalDispatches = events.reduce((sum, event) => sum + event.count, 0)
  const hottestEvent = events[0]?.name ?? "n/a"
  const avgLatency = events.length
    ? Math.round(events.reduce((sum, event) => sum + event.avgMs, 0) / events.length)
    : 0

  return (
    <section className="card panel-events">
      <h2 className="section-title">Dispatches{scope === "project" ? " (project)" : ""}</h2>
      <p className="section-subtitle">Dispatch counts and average durations by event</p>
      <div className="metric-kpis">
        <span className="metric-kpi">
          <strong>{totalDispatches}</strong> total dispatches
        </span>
        <span className="metric-kpi">
          <strong>{avgLatency} ms</strong> avg latency
        </span>
        <span className="metric-kpi">
          <strong>{hottestEvent}</strong> hottest event
        </span>
      </div>
      <p className="metric-note">Lower latency is better.</p>
      <details className="metric-details">
        <summary>Show event breakdown</summary>
        <table aria-label="Dispatch metrics by hook event">
          <caption className="sr-only">Dispatch counts and average durations by event</caption>
          <thead>
            <tr>
              <th scope="col">Event</th>
              <th scope="col">Count</th>
              <th scope="col">Avg</th>
            </tr>
          </thead>
          <tbody>
            {events.length === 0 ? (
              <tr>
                <td colSpan={3} className="empty">
                  No event data yet
                </td>
              </tr>
            ) : (
              events.map((event) => (
                <tr key={event.name}>
                  <td className="event-cell">
                    <span className="event-name">{event.name}</span>
                  </td>
                  <td className="count-col">
                    <div className="count-cell">
                      <span>{event.count}</span>
                      <span className="count-bar">
                        <span style={{ width: `${countWidth(maxCount, event.count)}%` }} />
                      </span>
                    </div>
                  </td>
                  <td className="avg-col">{event.avgMs} ms</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </details>
    </section>
  )
}
