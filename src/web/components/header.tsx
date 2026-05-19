import { motion } from "motion/react"
import type { ReactElement } from "react"
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

function AnimatedHeaderChip({ children, index }: { children: ReactElement; index: number }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.06, duration: 0.3, ease: "easeOut" }}
    >
      {children}
    </motion.div>
  )
}

function CountHeaderChip({ value, label, index }: { value: number; label: string; index: number }) {
  return (
    <AnimatedHeaderChip index={index}>
      <output className="header-chip" aria-label={`${value} ${label}`}>
        <strong>
          <NumberTicker value={value} />
        </strong>{" "}
        {label}
      </output>
    </AnimatedHeaderChip>
  )
}

function ProjectHeaderChip({
  selectedProjectName,
  index,
}: {
  selectedProjectName: string | null
  index: number
}) {
  return (
    <AnimatedHeaderChip index={index}>
      <output
        className="header-chip"
        aria-label={`Selected project ${selectedProjectName ?? "none"}`}
      >
        project: <strong>{selectedProjectName ?? "none"}</strong>
      </output>
    </AnimatedHeaderChip>
  )
}

function CacheHeaderChip({
  warmCaches,
  totalCacheEntries,
  index,
}: {
  warmCaches: number
  totalCacheEntries: number
  index: number
}) {
  if (totalCacheEntries <= 0) return null
  return (
    <AnimatedHeaderChip index={index}>
      <output
        className="header-chip"
        aria-label={`${warmCaches} warm daemon caches out of ${totalCacheEntries} total entries`}
      >
        daemon caches:{" "}
        <strong>
          <NumberTicker value={warmCaches} />
        </strong>{" "}
        warm /{" "}
        <strong>
          <NumberTicker value={totalCacheEntries} />
        </strong>{" "}
        total
      </output>
    </AnimatedHeaderChip>
  )
}

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
  return (
    <div className="header-chips">
      <CountHeaderChip value={activeHooks} label="active hooks" index={0} />
      <CountHeaderChip value={totalRunningAgents} label="running agents" index={1} />
      <ProjectHeaderChip selectedProjectName={selectedProjectName} index={2} />
      <CacheHeaderChip warmCaches={warmCaches} totalCacheEntries={totalCacheEntries} index={3} />
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
  cacheStatus,
  activeAgentProcessProviders = {},
}: HeaderProps): ReactElement {
  const { totalCacheEntries, warmCaches } = buildCacheEntries(cacheStatus)
  const totalRunningAgents = Object.values(activeAgentProcessProviders).reduce(
    (sum, pids) => sum + pids.length,
    0
  )
  const isActive = totalRunningAgents > 0 || activeHooks > 0
  const mascotSrc = isActive ? "/public/swiz-buzz-animated.svg" : "/public/swiz-buzz-flat.svg"
  const updated = formatLastUpdated(lastUpdated)

  return (
    <header className="bento-title">
      <div className="title-row-left">
        <img key={mascotSrc} src={mascotSrc} alt="swiz" className="title-mascot" />
        <h1 className="topbar-title">swiz daemon</h1>
        <output className="status-pill" aria-label="Daemon live">
          <span className="status-symbol" aria-hidden="true">
            ✓
          </span>
          <span>Live</span>
        </output>
      </div>
      <time className="topbar-meta" dateTime={updated.dateTime} title={updated.title}>
        Updated {updated.text}
      </time>
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
