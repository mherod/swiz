/**
 * A Map subclass with a hard size cap and LRU eviction.
 *
 * Extends Map so it's fully type-compatible with all existing `Map<K, V>`
 * consumers — no downstream signature changes needed. When `set()` would
 * exceed `maxSize`, the least-recently-used entry is evicted. Both `get()`
 * and `set()` promote entries to most-recently-used.
 */
export class CappedMap<K, V> extends Map<K, V> {
  private readonly maxSize: number

  constructor(maxSize: number) {
    super()
    this.maxSize = maxSize
  }

  override get(key: K): V | undefined {
    const value = super.get(key)
    if (value !== undefined) {
      // Promote to most-recently-used (move to end of insertion order)
      super.delete(key)
      super.set(key, value)
    }
    return value
  }

  override set(key: K, value: V): this {
    // Delete first so re-insert lands at the end (most-recent)
    if (super.has(key)) {
      super.delete(key)
    }
    // Evict oldest (first in iteration order) while at capacity
    while (super.size >= this.maxSize) {
      const oldest = super.keys().next()
      if (oldest.done) break
      super.delete(oldest.value)
    }
    return super.set(key, value)
  }
}
