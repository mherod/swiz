import { cn } from "../lib/cn.ts"

type CacheState = "cold" | "warm" | "hot"

function getCacheState(value: number): CacheState {
  if (value === 0) return "cold"
  if (value < 5) return "warm"
  return "hot"
}

function CacheRow({ label, value }: { label: string; value: number }) {
  const state = getCacheState(value)
  return (
    <li className="cache-row">
      <span className="cache-label">{label}</span>
      <span className="cache-value-wrap">
        <span className={cn("cache-badge", `cache-${state}`)}>{state}</span>
        <strong className="cache-count">{value}</strong>
      </span>
    </li>
  )
}

interface CacheSummary {
  snapshotCacheSize?: number
  ghCacheSize?: number
  eligibilityCacheSize?: number
  transcriptIndexSize?: number
  cooldownRegistrySize?: number
  gitStateCacheSize?: number
  projectSettingsCacheSize?: number
  manifestCacheSize?: number
}

export function CacheList({ cache = {} }: { cache?: CacheSummary }) {
  const cacheEntries = [
    { label: "Snapshots", value: cache.snapshotCacheSize ?? 0 },
    { label: "GitHub", value: cache.ghCacheSize ?? 0 },
    { label: "Eligibility", value: cache.eligibilityCacheSize ?? 0 },
    { label: "Transcripts", value: cache.transcriptIndexSize ?? 0 },
    { label: "Cooldown", value: cache.cooldownRegistrySize ?? 0 },
    { label: "Git state", value: cache.gitStateCacheSize ?? 0 },
    { label: "Settings", value: cache.projectSettingsCacheSize ?? 0 },
    { label: "Manifest", value: cache.manifestCacheSize ?? 0 },
  ]
  const totalEntries = cacheEntries.reduce((sum, item) => sum + item.value, 0)
  const warmCaches = cacheEntries.filter((item) => getCacheState(item.value) !== "cold").length

  return (
    <section className="card panel-cache">
      <h2 className="section-title">Caches</h2>
      <p className="section-subtitle">Current cache warmth and entry counts</p>
      <div className="metric-kpis">
        <span className="metric-kpi">
          <strong>{totalEntries}</strong> total entries
        </span>
        <span className="metric-kpi">
          <strong>{warmCaches}</strong> warm or hot caches
        </span>
      </div>
      <p className="metric-note">Higher warm cache count usually means faster reads.</p>
      <details className="metric-details">
        <summary>Show cache breakdown</summary>
        <ul className="cache-list" aria-label="Daemon cache size breakdown">
          {cacheEntries.map((item) => (
            <CacheRow key={item.label} label={item.label} value={item.value} />
          ))}
        </ul>
      </details>
    </section>
  )
}
