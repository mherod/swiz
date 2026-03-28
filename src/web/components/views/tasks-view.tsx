import type { ReactElement } from "react"
import type { ProjectTask, SessionTask, SessionTaskSummary } from "../session-browser-types.ts"
import { NewTaskForm, ProjectTasksSection, SessionTasksSection } from "../session-tasks.tsx"

export function TasksView({
  sessionTasks,
  sessionTaskSummary,
  sessionTasksLoading,
  projectTasks,
  projectTaskSummary,
  projectTasksLoading,
  sessionId,
  cwd,
}: {
  sessionTasks: SessionTask[]
  sessionTaskSummary: SessionTaskSummary | null
  sessionTasksLoading: boolean
  projectTasks: ProjectTask[]
  projectTaskSummary: SessionTaskSummary | null
  projectTasksLoading: boolean
  sessionId: string | null
  cwd: string | null
}): ReactElement {
  return (
    <div className="bento-full-page">
      <NewTaskForm sessionId={sessionId} cwd={cwd} />
      <SessionTasksSection
        tasks={sessionTasks}
        summary={sessionTaskSummary}
        loading={sessionTasksLoading}
      />
      <ProjectTasksSection
        tasks={projectTasks}
        summary={projectTaskSummary}
        loading={projectTasksLoading}
      />
    </div>
  )
}
