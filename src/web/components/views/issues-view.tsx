import { ProjectIssuesPanel } from "../project-issues-panel.tsx"

export function IssuesView({ cwd }: { cwd: string | null }) {
  return (
    <div className="bento-full-page">
      <ProjectIssuesPanel cwd={cwd} />
    </div>
  )
}
