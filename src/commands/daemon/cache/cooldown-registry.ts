export class CooldownRegistry {
  private entries = new Map<string, number>()

  private key(hookFile: string, cwd: string): string {
    return `${hookFile}\x00${cwd}`
  }

  isWithinCooldown(hookFile: string, cooldownSeconds: number, cwd: string): boolean {
    const lastRun = this.entries.get(this.key(hookFile, cwd))
    if (lastRun === undefined) return false
    return Date.now() - lastRun < cooldownSeconds * 1000
  }

  mark(hookFile: string, cwd: string): void {
    this.entries.set(this.key(hookFile, cwd), Date.now())
  }

  checkAndMark(hookFile: string, cooldownSeconds: number, cwd: string): boolean {
    if (this.isWithinCooldown(hookFile, cooldownSeconds, cwd)) return true
    this.mark(hookFile, cwd)
    return false
  }

  invalidateProject(cwd: string): void {
    for (const k of this.entries.keys()) {
      if (k.endsWith(`\x00${cwd}`)) this.entries.delete(k)
    }
  }

  invalidateAll(): void {
    this.entries.clear()
  }

  get size(): number {
    return this.entries.size
  }
}
