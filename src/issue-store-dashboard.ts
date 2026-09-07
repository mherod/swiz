/** Dashboard-only query policy; full-list store consumers retain their existing APIs. */
export interface DashboardStoreList<T> {
  records: T[]
  /** All TTL-visible rows, including rows the dashboard cannot render. */
  total: number
}

export function issueUpdatedAtMs(updatedAt: string | null): number {
  if (!updatedAt) return 0
  const parsed = Date.parse(updatedAt)
  return Number.isFinite(parsed) ? parsed : 0
}

/** Match dashboard normalization before LIMIT, then break equal timestamps by issue number. */
export function dashboardListSql(table: "issues" | "pull_requests"): string {
  const issueOnly =
    table === "issues"
      ? "AND json_type(data, '$.pull_request') IS NULL AND json_type(data, '$.pullRequest') IS NULL"
      : ""
  return `SELECT data FROM ${table}
    WHERE repo = ? AND synced_at > ?
      AND json_type(data, '$.number') IN ('integer', 'real')
      AND json_extract(data, '$.number') != 0
      AND json_type(data, '$.title') = 'text'
      AND length(json_extract(data, '$.title')) > 0
      ${issueOnly}
    ORDER BY COALESCE(julianday(CASE
      WHEN json_type(data, '$.updatedAt') = 'text' AND length(json_extract(data, '$.updatedAt')) > 0
        THEN json_extract(data, '$.updatedAt')
      WHEN json_type(data, '$.updated_at') = 'text' THEN json_extract(data, '$.updated_at')
      ELSE NULL END) - 2440587.5, 0) DESC, number ASC
    LIMIT ?`
}

export function dashboardListLimit(limit: number): number {
  return Number.isFinite(limit) ? Math.max(1, Math.min(30, Math.floor(limit))) : 10
}
