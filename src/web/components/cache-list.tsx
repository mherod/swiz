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
        <span className={`cache-badge cache-${state}`}>{state}</span>
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
  return (
    <section className="card panel-cache">
      <h2 className="section-title">Caches</h2>
      <p className="section-subtitle">Current cache warmth and entry counts</p>
      <ul className="cache-list" aria-label="Daemon cache size breakdown">
        <CacheRow label="Snapshots" value={cache.snapshotCacheSize ?? 0} />
        <CacheRow label="GitHub" value={cache.ghCacheSize ?? 0} />
        <CacheRow label="Eligibility" value={cache.eligibilityCacheSize ?? 0} />
        <CacheRow label="Transcripts" value={cache.transcriptIndexSize ?? 0} />
        <CacheRow label="Cooldown" value={cache.cooldownRegistrySize ?? 0} />
        <CacheRow label="Git state" value={cache.gitStateCacheSize ?? 0} />
        <CacheRow label="Settings" value={cache.projectSettingsCacheSize ?? 0} />
        <CacheRow label="Manifest" value={cache.manifestCacheSize ?? 0} />
      </ul>
    </section>
  )
}
