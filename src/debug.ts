/**
 * Arguments accepted by the debug logger — mirrors `console.error` semantics.
 * Includes `unknown` for catch-block errors (TS spec); this file is excluded
 * from the `@typescript-eslint/no-restricted-types` ESLint rule.
 */
type LogArg =
  | string
  | number
  | boolean
  | null
  | undefined
  | unknown
  | readonly LogArg[]
  | { [key: string]: LogArg }

/**
 * Debug logger gated on SWIZ_DEBUG env var.
 * Silent by default — enable with SWIZ_DEBUG=1 for diagnostic output.
 *
 * Use for informational messages (replay status, condition warnings,
 * cross-session resolution notices). Reserve stderrLog for user-facing
 * CLI output and hard failures only.
 */
export const debugLog: (...args: LogArg[]) => void = process.env.SWIZ_DEBUG
  ? console.error.bind(console)
  : () => {}

/**
 * Write a message to stderr with a mandatory justification string.
 *
 * Use this instead of bare `console.error` in production source files.
 * The `justification` parameter documents WHY this output belongs on stderr
 * (e.g. "CI failure status reporting", "interactive merge progress indicator").
 * When SWIZ_DEBUG is set, the justification is emitted via debugLog before the
 * message, making it auditable at runtime.
 *
 * @param justification - Non-empty string explaining why stderr output is appropriate here.
 * @param args - Arguments forwarded to console.error.
 */
export function stderrLog(justification: string, ...args: LogArg[]): void {
  debugLog(`[stderrLog] ${justification}`)
  console.error(...args)
}
