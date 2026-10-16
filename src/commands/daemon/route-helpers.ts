/**
 * Shared helpers for daemon HTTP route handlers.
 *
 * Lives in its own module so per-domain route files (e.g. cache-routes.ts) can
 * reuse it without importing back from web-server.ts, which would create an
 * import cycle. web-server.ts and the domain route modules both import from here.
 */
import { resolveProjectRoot } from "../../project-identity.ts"

type ProjectRouteContext = {
  touchProject: (cwd: string) => void
  registerProjectWatchers: (cwd: string) => void
}

/** Parse legacy cwd-only requests; relative paths remain usable without watcher registration. */
export async function readProjectRequestCwd(
  req: Request,
  ctx: ProjectRouteContext
): Promise<string | Response> {
  const body = (await req.json().catch(() => null)) as { cwd?: string } | null
  if (typeof body?.cwd !== "string" || !body.cwd) {
    return Response.json({ error: "Missing required field: cwd" }, { status: 400 })
  }
  return (await registerProjectAndTouch(ctx, body.cwd)) ?? body.cwd
}

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

/** Resolve an absolute route cwd to the canonical repository root used for daemon bookkeeping. */
export async function resolveRegisterableProjectCwd(cwd: string): Promise<string | null> {
  if (!isRegisterableProjectCwd(cwd)) return null
  return resolveProjectRoot(cwd)
}

/**
 * Canonical watcher registration then touch — standard order for POST routes
 * scoped to a project cwd. Returns the canonical root for downstream caches.
 */
export async function registerProjectAndTouch(
  ctx: ProjectRouteContext,
  cwd: string,
  signal?: AbortSignal
): Promise<string | null> {
  signal?.throwIfAborted()
  // Ignore placeholder/relative cwds so they don't pollute project bookkeeping.
  const projectCwd = await resolveRegisterableProjectCwd(cwd)
  signal?.throwIfAborted()
  if (!projectCwd) return null
  ctx.registerProjectWatchers(projectCwd)
  ctx.touchProject(projectCwd)
  return projectCwd
}
