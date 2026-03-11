type CacheState = "cold" | "warm" | "hot"

function getCacheState(value: number): CacheState {
  if (value === 0) {
    return "cold"
  }
  if (value < 5) {
    return "warm"
  }
  return "hot"
}

function row(label: string, value: number): string {
  const state = getCacheState(value)
  return `
    <li class="cache-row">
      <span>${label}</span>
      <span class="cache-value-wrap">
        <span class="cache-badge cache-${state}">${state}</span>
        <strong>${value}</strong>
      </span>
    </li>
  `
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

export function CacheList(cache: CacheSummary = {}): string {
  return `
    <section class="card section panel-cache">
      <div class="section-title-row">
        <h2>Cache Sizes</h2>
        <span class="section-subtitle">Memory utilization hints</span>
      </div>
      <ul class="cache-list" aria-label="Daemon cache size breakdown">
        ${row("Snapshots", cache.snapshotCacheSize ?? 0)}
        ${row("GitHub query", cache.ghCacheSize ?? 0)}
        ${row("Eligibility", cache.eligibilityCacheSize ?? 0)}
        ${row("Transcript index", cache.transcriptIndexSize ?? 0)}
        ${row("Cooldown", cache.cooldownRegistrySize ?? 0)}
        ${row("Git state", cache.gitStateCacheSize ?? 0)}
        ${row("Project settings", cache.projectSettingsCacheSize ?? 0)}
        ${row("Manifest", cache.manifestCacheSize ?? 0)}
      </ul>
    </section>
  `
}
