import { motion } from "motion/react"
import type { ActiveView } from "../lib/dashboard-state.ts"
import { NumberTicker } from "./number-ticker.tsx"

interface HeaderProps {
  lastUpdated: string
  uptime: string
  totalDispatches: number
  projects: number
  activeWatches: number
  activeHooks: number
  selectedProjectName: string | null
  activeView?: ActiveView
  onSelectView?: (view: ActiveView) => void
  cacheStatus?: Record<string, number> | null
  activeAgentProcessProviders?: Record<string, number[]>
}

const CACHE_LABELS: Array<{ label: string; key: string }> = [
  { label: "Snapshots", key: "snapshotCacheSize" },
  { label: "GitHub", key: "ghCacheSize" },
  { label: "Eligibility", key: "eligibilityCacheSize" },
  { label: "Transcripts", key: "transcriptIndexSize" },
  { label: "Cooldown", key: "cooldownRegistrySize" },
  { label: "Git state", key: "gitStateCacheSize" },
  { label: "Settings", key: "projectSettingsCacheSize" },
  { label: "Manifest", key: "manifestCacheSize" },
]

function buildCacheEntries(cacheStatus: Record<string, number> | null | undefined) {
  if (!cacheStatus) return { totalCacheEntries: 0, warmCaches: 0 }
  let total = 0
  let warm = 0
  for (const { key } of CACHE_LABELS) {
    const v = cacheStatus[key] ?? 0
    total += v
    if (v > 0) warm++
  }
  return { totalCacheEntries: total, warmCaches: warm }
}

function ViewToggleButton({
  label,
  active,
  onClick,
}: {
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`view-tab${active ? " view-tab-active" : ""}`}
    >
      {active && (
        <motion.span
          className="view-tab-indicator"
          layoutId="active-tab"
          transition={{ type: "spring", bounce: 0.2, duration: 0.4 }}
        />
      )}
      <span className="view-tab-label">{label}</span>
    </button>
  )
}

const TAB_LABELS: Array<{ view: ActiveView; label: string }> = [
  { view: "dashboard", label: "Dashboard" },
  { view: "issues", label: "Issues" },
  { view: "tasks", label: "Tasks" },
  { view: "transcript", label: "Transcript" },
  { view: "settings", label: "Project Settings" },
]

function HeaderChips({
  activeHooks,
  totalRunningAgents,
  selectedProjectName,
  warmCaches,
  totalCacheEntries,
}: {
  activeHooks: number
  totalRunningAgents: number
  selectedProjectName: string | null
  warmCaches: number
  totalCacheEntries: number
}) {
  const chips = [
    <span key="hooks" className="header-chip">
      <strong>
        <NumberTicker value={activeHooks} />
      </strong>{" "}
      active hooks
    </span>,
    <span key="agents" className="header-chip">
      <strong>
        <NumberTicker value={totalRunningAgents} />
      </strong>{" "}
      running agents
    </span>,
    <span key="project" className="header-chip">
      project: <strong>{selectedProjectName ?? "none"}</strong>
    </span>,
    totalCacheEntries > 0 ? (
      <span key="cache" className="header-chip">
        daemon caches:{" "}
        <strong>
          <NumberTicker value={warmCaches} />
        </strong>{" "}
        warm /{" "}
        <strong>
          <NumberTicker value={totalCacheEntries} />
        </strong>{" "}
        total
      </span>
    ) : null,
  ].filter(Boolean)

  return (
    <div className="header-chips">
      {chips.map((chip, i) => (
        <motion.div
          key={(chip as React.ReactElement).key}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: i * 0.06, duration: 0.3, ease: "easeOut" }}
        >
          {chip}
        </motion.div>
      ))}
    </div>
  )
}

export function Header({
  lastUpdated,
  uptime,
  totalDispatches,
  projects,
  activeWatches,
  activeHooks,
  selectedProjectName,
  activeView = "dashboard",
  onSelectView,
  cacheStatus,
  activeAgentProcessProviders = {},
}: HeaderProps) {
  const { totalCacheEntries, warmCaches } = buildCacheEntries(cacheStatus)
  const totalRunningAgents = Object.values(activeAgentProcessProviders).reduce(
    (sum, pids) => sum + pids.length,
    0
  )
  const isActive = totalRunningAgents > 0 || activeHooks > 0
  const mascotSrc = isActive ? "/public/swiz-buzz-animated.svg" : "/public/swiz-buzz-flat.svg"

  return (
    <header className="bento-title">
      <div className="title-row">
        <div className="title-row-left">
          <img src={mascotSrc} alt="swiz" className="title-mascot" />
          <h1 className="topbar-title">swiz daemon</h1>
          <output className="status-pill">
            <span className="status-dot" aria-hidden="true" />
            <span>Live</span>
          </output>
        </div>
        {onSelectView && (
          <div className="view-toggle">
            {TAB_LABELS.map(({ view, label }) => (
              <ViewToggleButton
                key={view}
                label={label}
                active={activeView === view}
                onClick={() => onSelectView(view)}
              />
            ))}
          </div>
        )}
      </div>
      <span className="topbar-meta">Updated {lastUpdated}</span>
      <p className="topbar-summary">
        {uptime} uptime · <NumberTicker value={totalDispatches} /> dispatches ·{" "}
        <NumberTicker value={projects} /> active projects · <NumberTicker value={activeWatches} />{" "}
        CI watches
      </p>
      <HeaderChips
        activeHooks={activeHooks}
        totalRunningAgents={totalRunningAgents}
        selectedProjectName={selectedProjectName}
        warmCaches={warmCaches}
        totalCacheEntries={totalCacheEntries}
      />
    </header>
  )
}
