import type { ReactElement } from "react"
import { cn } from "../lib/cn.ts"
import { msgKey } from "../lib/dashboard-helpers.ts"
import type { DashboardState } from "../lib/dashboard-state.ts"
import { useDashboardState } from "../lib/dashboard-state.ts"
import { Dock, DockIcon } from "./dock.tsx"
import { Header } from "./header.tsx"
import { SessionNav } from "./session-browser.tsx"
import { SettingsPanel } from "./settings-panel.tsx"
import { DashboardView } from "./views/dashboard-view.tsx"
import { IssuesView } from "./views/issues-view.tsx"
import { LogsView } from "./views/logs-view.tsx"
import { TasksView } from "./views/tasks-view.tsx"
import { TranscriptView } from "./views/transcript-view.tsx"

type DockView = "dashboard" | "issues" | "tasks" | "transcript" | "logs" | "settings"

const TAB_LABELS: Array<{
  view: DockView
  label: string
}> = [
  { view: "dashboard", label: "Dashboard" },
  { view: "issues", label: "Issues" },
  { view: "tasks", label: "Tasks" },
  { view: "transcript", label: "Transcript" },
  { view: "logs", label: "Logs" },
  { view: "settings", label: "Settings" },
]

const DOCK_GLYPH_PROPS = {
  width: 20,
  height: 20,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.75,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  focusable: "false",
} as const

function DockViewGlyph({ view }: { view: DockView }): ReactElement {
  if (view === "dashboard") {
    return (
      <svg {...DOCK_GLYPH_PROPS} aria-hidden="true">
        <rect x="4" y="4" width="6" height="6" rx="1.4" />
        <rect x="14" y="4" width="6" height="6" rx="1.4" />
        <rect x="4" y="14" width="6" height="6" rx="1.4" />
        <rect x="14" y="14" width="6" height="6" rx="1.4" />
      </svg>
    )
  }
  if (view === "issues") {
    return (
      <svg {...DOCK_GLYPH_PROPS} aria-hidden="true">
        <circle cx="12" cy="12" r="8.5" />
        <path d="M12 7.7v5.2" />
        <path d="M12 16.3h.01" strokeWidth="2.4" />
      </svg>
    )
  }
  if (view === "tasks") {
    return (
      <svg {...DOCK_GLYPH_PROPS} aria-hidden="true">
        <rect x="3.5" y="4" width="17" height="16" rx="2" />
        <path d="m7 11 2 2 3.5-4" />
        <path d="M14.5 10h3" />
        <path d="M14.5 14h3" />
      </svg>
    )
  }
  if (view === "transcript") {
    return (
      <svg {...DOCK_GLYPH_PROPS} aria-hidden="true">
        <rect x="3.5" y="4" width="17" height="16" rx="2" />
        <path d="m7.5 9 3 3-3 3" />
        <path d="M13 15h3.5" />
      </svg>
    )
  }
  if (view === "logs") {
    return (
      <svg {...DOCK_GLYPH_PROPS} aria-hidden="true">
        <path d="M7 6.5h11" />
        <path d="M7 12h11" />
        <path d="M7 17.5h11" />
        <circle cx="4.5" cy="6.5" r="0.7" fill="currentColor" stroke="none" />
        <circle cx="4.5" cy="12" r="0.7" fill="currentColor" stroke="none" />
        <circle cx="4.5" cy="17.5" r="0.7" fill="currentColor" stroke="none" />
      </svg>
    )
  }
  return <DockSettingsGlyph />
}

function DockSettingsGlyph(): ReactElement {
  return (
    <svg {...DOCK_GLYPH_PROPS} aria-hidden="true">
      <path d="M4 6.5h16" />
      <path d="M4 12h16" />
      <path d="M4 17.5h16" />
      <circle cx="9" cy="6.5" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="15" cy="12" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="11" cy="17.5" r="1.6" fill="currentColor" stroke="none" />
    </svg>
  )
}

function buildMessagesProps(state: DashboardState) {
  return {
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
    sessionTokenStats: state.sessionTokenStats,
    monitorMetric: state.projectMonitor,
  }
}

function DashboardDock({ state }: { state: DashboardState }) {
  return (
    <Dock className="dock-fixed" iconSize={44} iconMagnification={50} iconDistance={140}>
      {TAB_LABELS.map(({ view, label }) => (
        <DockIcon
          key={view}
          onClick={() => state.setActiveView(view)}
          aria-label={`Show ${label} view`}
          title={label}
          aria-current={state.activeView === view ? "page" : undefined}
          className={cn(state.activeView === view && "dock-icon-active")}
        >
          <span className="dock-icon-glyph" aria-hidden="true">
            <DockViewGlyph view={view} />
          </span>
          <span className="dock-icon-label">{label}</span>
        </DockIcon>
      ))}
    </Dock>
  )
}

function DashboardContent({ state }: { state: DashboardState }) {
  const { activeView, optimisticProjectCwd } = state

  if (activeView === "settings") {
    return <SettingsPanel cwd={optimisticProjectCwd} className="bento-settings-page" />
  }
  if (activeView === "issues") return <IssuesView cwd={optimisticProjectCwd} />
  if (activeView === "logs") return <LogsView />
  if (activeView === "tasks") {
    return (
      <TasksView
        sessionTasks={state.sessionTasks}
        sessionTaskSummary={state.sessionTaskSummary}
        sessionTasksLoading={state.sessionTasksLoading}
        projectTasks={state.projectTasks}
        projectTaskSummary={state.projectTaskSummary}
        projectTasksLoading={state.projectTasksLoading}
        sessionId={state.optimisticSessionId}
        cwd={state.optimisticProjectCwd}
      />
    )
  }

  const messagesProps = buildMessagesProps(state)
  if (activeView === "transcript") return <TranscriptView messagesProps={messagesProps} />
  return <DashboardView cwd={optimisticProjectCwd} messagesProps={messagesProps} />
}

export function DashboardApp(): ReactElement {
  const state = useDashboardState()

  return (
    <div className={`bento ${state.activeView === "settings" ? "bento-view-settings" : ""}`}>
      <Header
        lastUpdated={state.lastUpdated}
        uptime={state.m.uptimeHuman ?? "starting"}
        totalDispatches={state.m.totalDispatches ?? 0}
        projects={state.projectCount}
        activeWatches={state.watchCount}
        activeHooks={state.activeHookDispatches.length}
        cacheStatus={state.cacheStatus}
        activeAgentProcessProviders={state.optimisticAgentProcessProviders}
      />
      <DashboardDock state={state} />
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
      <main
        id="main-content"
        tabIndex={-1}
        className={cn("bento-main", state.activeView === "settings" && "bento-main-settings")}
      >
        {state.error ? (
          <section className="card bento-error" role="alert" aria-live="assertive">
            <h2>Error</h2>
            <p>{state.error}</p>
          </section>
        ) : (
          <DashboardContent state={state} />
        )}
      </main>
    </div>
  )
}
