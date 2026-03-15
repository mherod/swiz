import type { ComponentProps } from "react"
import { ProjectIssuesPanel } from "../project-issues-panel.tsx"
import { SessionMessages } from "../session-browser.tsx"

type MessagesProps = ComponentProps<typeof SessionMessages>

export function DashboardView({
  cwd,
  messagesProps,
}: {
  cwd: string | null
  messagesProps: MessagesProps
}) {
  return (
    <div className="bento-dashboard-stack">
      <div className="bento-dashboard-secondary">
        <ProjectIssuesPanel cwd={cwd} />
      </div>
      <div className="bento-dashboard-primary">
        <SessionMessages {...messagesProps} />
      </div>
    </div>
  )
}
