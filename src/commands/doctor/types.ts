/** Result of a single diagnostic check. */
export interface CheckResult {
  name: string
  status: "pass" | "warn" | "fail"
  detail: string
}

/** Context passed to each diagnostic check. */
export interface DiagnosticContext {
  fix: boolean
  /** Mutable store for checks that produce data consumed by auto-fix handlers. */
  store: Record<string, unknown>
}

/** A pluggable diagnostic check for `swiz doctor`. */
export interface DiagnosticCheck {
  name: string
  run(ctx: DiagnosticContext): Promise<CheckResult | CheckResult[]>
}
