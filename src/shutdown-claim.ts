// ─── Graceful-shutdown claims ────────────────────────────────────────────────
//
// index.ts exits immediately on SIGINT/SIGTERM. A long-running command that must
// finish its current step first (e.g. `swiz skill --sync-watch` completing a
// directory swap) claims those signals while it runs; index.ts then leaves the
// first signal to the command and only force-exits on a repeat.

let claims = 0

/** Take ownership of SIGINT/SIGTERM handling; call the returned function to release it. */
export function claimShutdownSignals(): () => void {
  claims++
  let released = false
  return () => {
    if (released) return
    released = true
    claims--
  }
}

export function shutdownSignalsClaimed(): boolean {
  return claims > 0
}
