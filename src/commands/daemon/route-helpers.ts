/**
 * Shared helpers for daemon HTTP route handlers.
 *
 * Lives in its own module so per-domain route files (e.g. cache-routes.ts) can
 * reuse it without importing back from web-server.ts, which would create an
 * import cycle. web-server.ts and the domain route modules both import from here.
 */

/** Watcher registration then touch — standard order for POST routes scoped to a project cwd. */
export function registerProjectAndTouch(
  ctx: { touchProject: (cwd: string) => void; registerProjectWatchers: (cwd: string) => void },
  cwd: string
): void {
  ctx.registerProjectWatchers(cwd)
  ctx.touchProject(cwd)
}
