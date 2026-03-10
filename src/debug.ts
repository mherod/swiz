/**
 * Debug logger gated on SWIZ_DEBUG env var.
 * Silent by default — enable with SWIZ_DEBUG=1 for diagnostic output.
 *
 * Use for informational messages (replay status, condition warnings,
 * cross-session resolution notices). Reserve stderrLog for user-facing
 * CLI output and hard failures only.
 */
export const debugLog: (...args: unknown[]) => void = process.env.SWIZ_DEBUG
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
export function stderrLog(justification: string, ...args: unknown[]): void {
  debugLog(`[stderrLog] ${justification}`)
  console.error(...args)
}
