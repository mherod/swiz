import type { ReactElement } from "react"
import { ProjectIssuesPanel } from "../project-issues-panel.tsx"

export function IssuesView({ cwd }: { cwd: string | null }): ReactElement {
  return (
    <div className="bento-full-page">
      <ProjectIssuesPanel cwd={cwd} />
    </div>
  )
}
