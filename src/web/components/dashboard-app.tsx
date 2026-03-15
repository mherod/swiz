import { msgKey } from "../lib/dashboard-helpers.ts"
import { useDashboardState } from "../lib/dashboard-state.ts"
import { Header } from "./header.tsx"
import { ProjectIssuesPanel } from "./project-issues-panel.tsx"
import { SessionMessages, SessionNav } from "./session-browser.tsx"
import { ProjectTasksSection, SessionTasksSection } from "./session-tasks.tsx"
import { SettingsPanel } from "./settings-panel.tsx"

type DashboardState = ReturnType<typeof useDashboardState>

function DashboardContent({ state }: { state: DashboardState }) {
  const { activeView, optimisticProjectCwd } = state

  if (activeView === "settings") {
    return (
      <div className="bento-settings-page">
        <SettingsPanel cwd={optimisticProjectCwd} />
      </div>
    )
  }

  if (activeView === "issues") {
    return (
      <div className="bento-full-page">
        <ProjectIssuesPanel cwd={optimisticProjectCwd} />
      </div>
    )
  }

  if (activeView === "tasks") {
    return (
      <div className="bento-full-page">
        <SessionTasksSection
          tasks={state.sessionTasks}
          summary={state.sessionTaskSummary}
          loading={state.sessionTasksLoading}
        />
        <ProjectTasksSection
          tasks={state.projectTasks}
          summary={state.projectTaskSummary}
          loading={state.projectTasksLoading}
        />
      </div>
    )
  }

  const messagesProps = {
    messages: state.displayedMessages,
    loading: state.messagesLoading,
    newKeys: state.newMessageKeys,
    msgKey,
    toolStats: state.sessionToolStats,
    tasks: state.sessionTasks,
    taskSummary: state.sessionTaskSummary,
    tasksLoading: state.sessionTasksLoading,
    projectTasks: state.projectTasks,
    projectTaskSummary: state.projectTaskSummary,
    projectTasksLoading: state.projectTasksLoading,
    events: state.metricsEvents,
    cacheStatus: state.cacheStatus,
    activeSession: state.activeSession,
    activeHookDispatches: state.activeHookDispatches,
  }

  if (activeView === "transcript") {
    return (
      <div className="bento-full-page">
        <SessionMessages {...messagesProps} hideTasks />
      </div>
    )
  }

  return (
    <div className="bento-dashboard-stack">
      <div className="bento-dashboard-secondary">
        <ProjectIssuesPanel cwd={optimisticProjectCwd} />
      </div>
      <div className="bento-dashboard-primary">
        <SessionMessages {...messagesProps} />
      </div>
    </div>
  )
}

export function DashboardApp() {
  const state = useDashboardState()

  return (
    <div className={`bento ${state.activeView === "settings" ? "bento-view-settings" : ""}`}>
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        Dashboard updated at {state.lastUpdated}.
      </p>
      {state.error ? (
        <section className="card bento-error" role="alert" aria-live="assertive">
          <h2>Error</h2>
          <p>{state.error}</p>
        </section>
      ) : null}
      <Header
        lastUpdated={state.lastUpdated}
        uptime={state.m.uptimeHuman ?? "starting"}
        totalDispatches={state.m.totalDispatches ?? 0}
        projects={state.projectCount}
        activeWatches={state.watchCount}
        activeHooks={state.activeHookDispatches.length}
        selectedProjectName={state.activeProject?.name ?? null}
        activeView={state.activeView}
        onSelectView={state.setActiveView}
        cacheStatus={state.cacheStatus}
        activeAgentProcessProviders={state.optimisticAgentProcessProviders}
      />
      <SessionNav
        projects={state.visibleProjects}
        activeAgentPidsByProvider={state.optimisticAgentProcessProviders}
        killingPids={state.optimisticKillingPids}
        deletingSessionId={state.deletingSessionId}
        selectedProjectCwd={state.optimisticProjectCwd}
        selectedSessionId={state.optimisticSessionId}
        onSelectProject={state.handleSelectProject}
        onSelectSession={state.handleSelectSession}
        onKillAgentPid={state.handleKillAgentPid}
        onDeleteSession={state.handleDeleteSession}
      />
      <DashboardContent state={state} />
    </div>
  )
}
