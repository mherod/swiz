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

  return (
    <section className="card panel-events">
      <h2 className="section-title">Dispatches{scope === "project" ? " (project)" : ""}</h2>
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
                <td>
                  <span className="event-name">{event.name}</span>
                </td>
                <td>
                  <div className="count-cell">
                    <span>{event.count}</span>
                    <span className="count-bar">
                      <span style={{ width: `${countWidth(maxCount, event.count)}%` }} />
                    </span>
                  </div>
                </td>
                <td>{event.avgMs} ms</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </section>
  )
}
