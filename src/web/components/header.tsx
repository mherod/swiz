import { useReducedMotion } from "motion/react"
import type { ReactElement } from "react"
import type { ActiveView } from "../lib/dashboard-state.ts"

interface HeaderProps {
  lastUpdated: string
  uptime: string
  totalDispatches: number
  projects: number
  activeWatches: number
  activeHooks: number
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

function formatLastUpdated(value: string): { text: string; title?: string; dateTime?: string } {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return { text: value }
  const diffSeconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000))
  if (diffSeconds < 5) return { text: "just now", title: value, dateTime: value }
  if (diffSeconds < 60) return { text: `${diffSeconds}s ago`, title: value, dateTime: value }
  const diffMinutes = Math.round(diffSeconds / 60)
  if (diffMinutes < 60) return { text: `${diffMinutes}m ago`, title: value, dateTime: value }
  const diffHours = Math.round(diffMinutes / 60)
  return { text: `${diffHours}h ago`, title: value, dateTime: value }
}

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

function CountHeaderChip({ value, label }: { value: number; label: string }) {
  return (
    <span className="header-chip">
      <strong>{value}</strong> {label}
    </span>
  )
}

function CacheHeaderChip({
  warmCaches,
  totalCacheEntries,
}: {
  warmCaches: number
  totalCacheEntries: number
}) {
  if (totalCacheEntries <= 0) return null
  return (
    <span className="header-chip">
      <strong>
        {warmCaches}/{totalCacheEntries}
      </strong>{" "}
      caches warm
    </span>
  )
}

function HeaderChips({
  activeHooks,
  totalRunningAgents,
  warmCaches,
  totalCacheEntries,
}: {
  activeHooks: number
  totalRunningAgents: number
  warmCaches: number
  totalCacheEntries: number
}) {
  return (
    <div className="header-chips">
      <CountHeaderChip value={activeHooks} label="active hooks" />
      <CountHeaderChip value={totalRunningAgents} label="running agents" />
      <CacheHeaderChip warmCaches={warmCaches} totalCacheEntries={totalCacheEntries} />
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
  cacheStatus,
  activeAgentProcessProviders = {},
}: HeaderProps): ReactElement {
  const reduceMotion = useReducedMotion()
  const { totalCacheEntries, warmCaches } = buildCacheEntries(cacheStatus)
  const totalRunningAgents = Object.values(activeAgentProcessProviders).reduce(
    (sum, pids) => sum + pids.length,
    0
  )
  const isActive = totalRunningAgents > 0 || activeHooks > 0
  const mascotSrc =
    isActive && !reduceMotion ? "/public/swiz-buzz-animated.svg" : "/public/swiz-buzz-flat.svg"
  const updated = formatLastUpdated(lastUpdated)

  return (
    <header className="bento-title">
      <div className="topbar-primary">
        <div className="title-row-left">
          <img key={mascotSrc} src={mascotSrc} alt="" className="title-mascot" />
          <h1 className="topbar-title">swiz daemon</h1>
          <span className="status-pill">
            <span className="status-pulse-dot" aria-hidden="true" />
            <span className="status-symbol" aria-hidden="true">
              ✓
            </span>
            <span>Live</span>
          </span>
        </div>
        <time className="topbar-meta" dateTime={updated.dateTime} title={updated.title}>
          Updated {updated.text}
        </time>
      </div>
      <div className="topbar-secondary">
        <p className="topbar-summary">
          {uptime} uptime · {totalDispatches} dispatches · {projects} active projects ·{" "}
          {activeWatches} CI watches
        </p>
        <HeaderChips
          activeHooks={activeHooks}
          totalRunningAgents={totalRunningAgents}
          warmCaches={warmCaches}
          totalCacheEntries={totalCacheEntries}
        />
      </div>
    </header>
  )
}
