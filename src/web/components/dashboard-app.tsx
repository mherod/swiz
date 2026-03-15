import { AnimatePresence, motion } from "motion/react"
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
import { TasksView } from "./views/tasks-view.tsx"
import { TranscriptView } from "./views/transcript-view.tsx"

const TAB_LABELS: Array<{
  view: "dashboard" | "issues" | "tasks" | "transcript" | "settings"
  label: string
  icon: string
}> = [
  { view: "dashboard", label: "Dashboard", icon: "◩" },
  { view: "issues", label: "Issues", icon: "◉" },
  { view: "tasks", label: "Tasks", icon: "☑" },
  { view: "transcript", label: "Transcript", icon: "❯" },
  { view: "settings", label: "Settings", icon: "⚙" },
]

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
  }
}

function DashboardDock({ state }: { state: DashboardState }) {
  return (
    <Dock className="dock-fixed" iconSize={36} iconMagnification={54} iconDistance={140}>
      {state.activeProject?.name ? (
        <DockIcon disableMagnification className="dock-icon-project">
          <span className="dock-icon-label">{state.activeProject.name}</span>
        </DockIcon>
      ) : null}
      {TAB_LABELS.map(({ view, label, icon }) => (
        <DockIcon
          key={view}
          onClick={() => state.setActiveView(view)}
          className={cn(state.activeView === view && "dock-icon-active")}
        >
          <span className="dock-icon-glyph">{icon}</span>
          <span className="dock-icon-label">{label}</span>
        </DockIcon>
      ))}
    </Dock>
  )
}

function DashboardContent({ state }: { state: DashboardState }) {
  const { activeView, optimisticProjectCwd } = state

  if (activeView === "settings") {
    return (
      <div className="bento-settings-page">
        <SettingsPanel cwd={optimisticProjectCwd} />
      </div>
    )
  }
  if (activeView === "issues") return <IssuesView cwd={optimisticProjectCwd} />
  if (activeView === "tasks") {
    return (
      <TasksView
        sessionTasks={state.sessionTasks}
        sessionTaskSummary={state.sessionTaskSummary}
        sessionTasksLoading={state.sessionTasksLoading}
        projectTasks={state.projectTasks}
        projectTaskSummary={state.projectTaskSummary}
        projectTasksLoading={state.projectTasksLoading}
      />
    )
  }

  const messagesProps = buildMessagesProps(state)
  if (activeView === "transcript") return <TranscriptView messagesProps={messagesProps} />
  return <DashboardView cwd={optimisticProjectCwd} messagesProps={messagesProps} />
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
      <AnimatePresence mode="wait">
        <motion.div
          key={state.activeView}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.2, ease: "easeInOut" }}
          style={{ display: "contents" }}
        >
          <DashboardContent state={state} />
        </motion.div>
      </AnimatePresence>
      <DashboardDock state={state} />
    </div>
  )
}
