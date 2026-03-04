/**
 * Debug logger gated on SWIZ_DEBUG env var.
 * Silent by default — enable with SWIZ_DEBUG=1 for diagnostic output.
 *
 * Use for informational messages (replay status, condition warnings,
 * cross-session resolution notices). Reserve direct console.error
 * for user-facing CLI output and hard failures only.
 */
export const debugLog: (...args: unknown[]) => void = process.env.SWIZ_DEBUG
  ? console.error.bind(console)
  : () => {}
