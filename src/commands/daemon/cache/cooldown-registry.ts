import { CappedMap } from "./capped-map.ts"

export class CooldownRegistry {
  private entries = new CappedMap<string, number>(2000)

  // The session segment keeps session-scoped windows disjoint per session while
  // callers that omit it keep the shared repo-scoped key (issue #847).
  private key(hookFile: string, cwd: string, sessionId?: string): string {
    return `${hookFile}\x00${cwd}${sessionId ? `\x00${sessionId}` : ""}`
  }

  isWithinCooldown(
    hookFile: string,
    cooldownSeconds: number,
    cwd: string,
    sessionId?: string
  ): boolean {
    const lastRun = this.entries.get(this.key(hookFile, cwd, sessionId))
    if (lastRun === undefined) return false
    return Date.now() - lastRun < cooldownSeconds * 1000
  }

  mark(hookFile: string, cwd: string, sessionId?: string): void {
    this.entries.set(this.key(hookFile, cwd, sessionId), Date.now())
  }

  checkAndMark(
    hookFile: string,
    cooldownSeconds: number,
    cwd: string,
    sessionId?: string
  ): boolean {
    if (this.isWithinCooldown(hookFile, cooldownSeconds, cwd, sessionId)) return true
    this.mark(hookFile, cwd, sessionId)
    return false
  }

  invalidateProject(cwd: string): void {
    for (const k of this.entries.keys()) {
      // Session-scoped keys carry a trailing \x00<sessionId> segment, so a
      // suffix match alone would leave them behind (issue #847 follow-up).
      if (k.endsWith(`\x00${cwd}`) || k.includes(`\x00${cwd}\x00`)) this.entries.delete(k)
    }
  }

  invalidateAll(): void {
    this.entries.clear()
  }

  get size(): number {
    return this.entries.size
  }
}
