import { msgKey } from "../lib/dashboard-helpers.ts"
import { useDashboardState } from "../lib/dashboard-state.ts"
import { Header } from "./header.tsx"
import { SessionMessages, SessionNav } from "./session-browser.tsx"
import { SettingsPanel } from "./settings-panel.tsx"

export function DashboardApp() {
  const {
    error,
    lastUpdated,
    m,
    projectCount,
    watchCount,
    activeHookDispatches,
    activeProject,
    activeView,
    setActiveView,
    visibleProjects,
    optimisticAgentProcessProviders,
    optimisticKillingPids,
    deletingSessionId,
    optimisticProjectCwd,
    optimisticSessionId,
    handleSelectProject,
    handleSelectSession,
    handleKillAgentPid,
    handleDeleteSession,
    displayedMessages,
    messagesLoading,
    newMessageKeys,
    sessionToolStats,
    sessionTasks,
    sessionTaskSummary,
    sessionTasksLoading,
    projectTasks,
    projectTaskSummary,
    projectTasksLoading,
    metricsEvents,
    cacheStatus,
    activeSession,
  } = useDashboardState()

  return (
    <div className={`bento ${activeView === "settings" ? "bento-view-settings" : ""}`}>
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        Dashboard updated at {lastUpdated}.
      </p>
      {error ? (
        <section className="card bento-error" role="alert" aria-live="assertive">
          <h2>Error</h2>
          <p>{error}</p>
        </section>
      ) : null}
      <Header
        lastUpdated={lastUpdated}
        uptime={m.uptimeHuman ?? "starting"}
        totalDispatches={m.totalDispatches ?? 0}
        projects={projectCount}
        activeWatches={watchCount}
        activeHooks={activeHookDispatches.length}
        selectedProjectName={activeProject?.name ?? null}
        activeView={activeView}
        onSelectView={setActiveView}
        cacheStatus={cacheStatus}
        activeAgentProcessProviders={optimisticAgentProcessProviders}
      />
      <SessionNav
        projects={visibleProjects}
        activeAgentPidsByProvider={optimisticAgentProcessProviders}
        killingPids={optimisticKillingPids}
        deletingSessionId={deletingSessionId}
        selectedProjectCwd={optimisticProjectCwd}
        selectedSessionId={optimisticSessionId}
        onSelectProject={handleSelectProject}
        onSelectSession={handleSelectSession}
        onKillAgentPid={handleKillAgentPid}
        onDeleteSession={handleDeleteSession}
      />
      {activeView === "settings" ? (
        <div className="bento-settings-page">
          <SettingsPanel cwd={optimisticProjectCwd} />
        </div>
      ) : (
        <>
          <SessionMessages
            messages={displayedMessages}
            loading={messagesLoading}
            newKeys={newMessageKeys}
            msgKey={msgKey}
            toolStats={sessionToolStats}
            tasks={sessionTasks}
            taskSummary={sessionTaskSummary}
            tasksLoading={sessionTasksLoading}
            projectTasks={projectTasks}
            projectTaskSummary={projectTaskSummary}
            projectTasksLoading={projectTasksLoading}
            events={metricsEvents}
            cacheStatus={cacheStatus}
            activeSession={activeSession}
            activeHookDispatches={activeHookDispatches}
          />
        </>
      )}
    </div>
  )
}
