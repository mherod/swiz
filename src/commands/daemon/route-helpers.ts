/**
 * Shared helpers for daemon HTTP route handlers.
 *
 * Lives in its own module so per-domain route files (e.g. cache-routes.ts) can
 * reuse it without importing back from web-server.ts, which would create an
 * import cycle. web-server.ts and the domain route modules both import from here.
 */

/**
 * True when `cwd` is a usable project identity — an absolute filesystem path.
 * Placeholder cwds like `"."` (sent by DaemonBackedIssueStore, which has no real
 * cwd at repo-scoped call sites) must never become projects: they consume a
 * watcher slot, register `.git/` watchers relative to the daemon's own cwd, and
 * spawn a duplicate upstream-sync loop keyed on the placeholder (#716).
 */
export function isRegisterableProjectCwd(cwd: string): boolean {
  return typeof cwd === "string" && cwd.startsWith("/")
}

/** Watcher registration then touch — standard order for POST routes scoped to a project cwd. */
export function registerProjectAndTouch(
  ctx: { touchProject: (cwd: string) => void; registerProjectWatchers: (cwd: string) => void },
  cwd: string
): void {
  // Ignore placeholder/relative cwds so they don't pollute project bookkeeping.
  if (!isRegisterableProjectCwd(cwd)) return
  ctx.registerProjectWatchers(cwd)
  ctx.touchProject(cwd)
}
