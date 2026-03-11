interface EventMetric {
  name: string
  count: number
  avgMs: number
}

export function EventTable(events: EventMetric[] = []): string {
  const maxCount = events.reduce((max, event) => Math.max(max, event.count), 0)
  const rows =
    events.length === 0
      ? `<tr><td colspan="3" class="empty">No event data yet</td></tr>`
      : events
          .map(
            (event) => `
            <tr>
              <td>
                <span class="event-name">${event.name}</span>
              </td>
              <td>
                <div class="count-cell">
                  <span>${event.count}</span>
                  <span class="count-bar">
                    <span style="width:${countWidth(maxCount, event.count)}%"></span>
                  </span>
                </div>
              </td>
              <td>${event.avgMs} ms</td>
            </tr>
          `
          )
          .join("")

  return `
    <section class="card section panel-events">
      <div class="section-title-row">
        <h2>Dispatches by Event</h2>
        <span class="section-subtitle">Top hook traffic</span>
      </div>
      <table aria-label="Dispatch metrics by hook event">
        <caption class="sr-only">Dispatch counts and average durations by event</caption>
        <thead>
          <tr>
            <th scope="col">Event</th>
            <th scope="col">Count</th>
            <th scope="col">Avg</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </section>
  `
}

function countWidth(maxCount: number, eventCount: number): number {
  if (maxCount === 0) {
    return 0
  }
  return Math.round((eventCount / maxCount) * 100)
}
