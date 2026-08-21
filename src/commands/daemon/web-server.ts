import { dirname, extname, join } from "node:path"
import tailwindcss from "bun-plugin-tailwind"
import { CappedMap } from "./cache/capped-map.ts"
import { handleCacheRoutes } from "./cache-routes.ts"
import { handleCiRoutes } from "./ci-routes.ts"
import {
  handleComplianceCurrent,
  handleComplianceRecord,
  handleStatusLineSnapshot,
  resolveComplianceDurationLabel,
} from "./compliance-routes.ts"
import {
  buildDispatchRoutesContext,
  handleDispatchActive,
  handleDispatchRoute,
  reapStaleDispatches,
} from "./dispatch-routes.ts"
import {
  handleProjectIssuesRoute,
  handleProjectPrsRoute,
  handleProjectSyncNow,
} from "./issue-routes.ts"
import { handleMcpToolRoute } from "./mcp-tool-routes.ts"
import {
  handleCacheStatus,
  handleGhRateLimit,
  handleHookLogs,
  handleMetricsRoute,
} from "./metrics-routes.ts"
import { handleProcessAgents, handleProcessKill, handleSessionDelete } from "./process-routes.ts"
import { handleSessionRoutes } from "./session-routes.ts"
import { handleSettingsRoutes } from "./settings-routes.ts"
import {
  buildCacheRoutesContext,
  buildCiRoutesContext,
  buildComplianceRoutesContext,
  buildIssueRoutesContext,
  buildMetricsRoutesContext,
  buildSessionRoutesContext,
  buildSettingsRoutesContext,
  type DaemonWebServerContext,
} from "./web-server-context.ts"

export type { DaemonWebServerContext } from "./web-server-context.ts"
export { formatWebProjectStatusLine } from "./web-server-context.ts"
export { resolveComplianceDurationLabel }

type DaemonWebServerHandle = ReturnType<typeof Bun.serve>

export const WEB_ROOT = join(dirname(Bun.main), "src", "web")
export const PUBLIC_ROOT = join(dirname(Bun.main), "www", "public")
let _tsxTranspiler: InstanceType<typeof Bun.Transpiler> | undefined
let _tsTranspiler: InstanceType<typeof Bun.Transpiler> | undefined

/** Lazy-init to avoid CurrentWorkingDirectoryUnlinked when imported from tests. */
export function getWebTsxTranspiler(): InstanceType<typeof Bun.Transpiler> {
  if (!_tsxTranspiler) _tsxTranspiler = new Bun.Transpiler({ loader: "tsx", autoImportJSX: true })
  return _tsxTranspiler
}
export function getWebTsTranspiler(): InstanceType<typeof Bun.Transpiler> {
  if (!_tsTranspiler) _tsTranspiler = new Bun.Transpiler({ loader: "ts" })
  return _tsTranspiler
}

export const WEB_MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".ts": "text/javascript; charset=utf-8",
  ".tsx": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
}

export function resolveWebAssetPath(pathname: string): string | null {
  const relativeRaw = pathname === "/" ? "index.html" : pathname.replace(/^\/web\/?/, "")
  const relative = relativeRaw.replace(/^\/+/, "")
  if (!relative || relative.includes("..")) return null
  return join(WEB_ROOT, relative)
}

/**
 * Modules outside `src/web` that a browser bundle is allowed to import.
 *
 * A dashboard component importing `../../tasks/task-topology.ts` makes the browser request
 * `/tasks/task-topology.ts`, which resolves outside WEB_ROOT and 404s — the module silently never
 * loads and the whole app fails to mount. Rather than serving the source tree wholesale, each
 * shared module is listed here: these are pure, browser-safe helpers whose logic must not be
 * duplicated into `src/web` just to be reachable, because the copy would drift from the CLI's.
 *
 * Add a path here only when the module is pure — no filesystem, no process, no Node builtins.
 */
export const SHARED_WEB_MODULES: ReadonlySet<string> = new Set([
  "/format-duration.ts",
  "/project-key.ts",
  "/tasks/task-timing.ts",
  "/tasks/task-topology.ts",
])

/**
 * The `src/` directory, located from this file rather than from `Bun.main`.
 *
 * `dirname(Bun.main)` is the entrypoint's directory, which is the repo root when the daemon runs
 * but the test runner's path under `bun test` — a shared module would then resolve to a file that
 * does not exist, and the only symptom would be a 404 in the browser. This file's own location is
 * stable under `bun link`, `bun test`, and direct execution alike.
 */
const SRC_ROOT = join(import.meta.dir, "..", "..")

/** Absolute path for an allowlisted shared module, or null when the request is not one. */
export function resolveSharedModulePath(pathname: string): string | null {
  if (!SHARED_WEB_MODULES.has(pathname)) return null
  return join(SRC_ROOT, pathname.replace(/^\/+/, ""))
}

// ─── Web asset cache ──────────────────────────────────────────────────────
// Avoids per-request transpile/build when source files haven't changed.
// Keyed by filePath; invalidated when mtime changes.

interface CachedWebAsset {
  mtimeMs: number
  body: string | ArrayBuffer
  contentType: string
}

const webAssetCache = new CappedMap<string, CachedWebAsset>(200)

async function buildWebAsset(
  filePath: string,
  file: ReturnType<typeof Bun.file>,
  mtimeMs: number
): Promise<{ body: string | ArrayBuffer; contentType: string }> {
  const extension = extname(filePath)
  if (extension === ".tsx" || extension === ".ts") {
    const source = await file.text()
    const code =
      extension === ".tsx"
        ? getWebTsxTranspiler().transformSync(source)
        : getWebTsTranspiler().transformSync(source)
    const contentType = "text/javascript; charset=utf-8"
    webAssetCache.set(filePath, { mtimeMs, body: code, contentType })
    return { body: code, contentType }
  }
  if (extension === ".css") {
    const result = await Bun.build({ entrypoints: [filePath], plugins: [tailwindcss] })
    const output = result.outputs[0]
    if (output) {
      const contentType = "text/css; charset=utf-8"
      const body = await output.text()
      webAssetCache.set(filePath, { mtimeMs, body, contentType })
      return { body, contentType }
    }
  }
  const contentType = WEB_MIME_TYPES[extname(filePath)] ?? "application/octet-stream"
  return { body: await file.arrayBuffer(), contentType }
}

/** Serve one allowlisted shared module, or null when the path is not in SHARED_WEB_MODULES. */
export async function serveSharedModule(pathname: string): Promise<Response | null> {
  const filePath = resolveSharedModulePath(pathname)
  return filePath ? await serveResolvedFile(filePath) : null
}

/**
 * One exact GET route per shared module.
 *
 * Exact paths rather than a prefix wildcard: `/tasks/*` also matches `POST /tasks/create`, and
 * shadowing that route silently turned dashboard task creation into a 404.
 */
export function sharedModuleRoutes(
  notFound: () => Response
): Record<string, (req: Request) => Promise<Response>> {
  const routes: Record<string, (req: Request) => Promise<Response>> = {}
  for (const pathname of SHARED_WEB_MODULES) {
    routes[pathname] = async (req: Request) => {
      if (req.method !== "GET") return notFound()
      return (await serveSharedModule(pathname)) ?? notFound()
    }
  }
  return routes
}

export async function serveWebAsset(pathname: string): Promise<Response | null> {
  const filePath = resolveSharedModulePath(pathname) ?? resolveWebAssetPath(pathname)
  if (!filePath) {
    return new Response("Bad Request", { status: 400 })
  }
  return await serveResolvedFile(filePath)
}

async function serveResolvedFile(filePath: string): Promise<Response | null> {
  const file = Bun.file(filePath)
  if (!(await file.exists())) return null

  const stat = await file.stat()
  const mtimeMs = stat.mtimeMs ?? 0
  const lastModified = stat.mtime ? new Date(stat.mtime).toUTCString() : undefined

  const cached = webAssetCache.get(filePath)
  if (cached && cached.mtimeMs === mtimeMs) {
    return new Response(cached.body, {
      headers: {
        "cache-control": "max-age=5",
        "content-type": cached.contentType,
        ...(lastModified && { "last-modified": lastModified }),
      },
    })
  }

  const built = await buildWebAsset(filePath, file, mtimeMs)
  return new Response(built.body, {
    headers: {
      "cache-control": "max-age=5",
      "content-type": built.contentType,
      ...(lastModified && { "last-modified": lastModified }),
    },
  })
}

type TopRouteHandler = (
  req: Request,
  url: URL,
  ctx: DaemonWebServerContext
) => Promise<Response> | Response

const TOP_ROUTE_TABLE: Record<string, TopRouteHandler> = {
  "POST /dispatch": (req, url, ctx) =>
    handleDispatchRoute(req, url, buildDispatchRoutesContext(ctx)),
  "GET /dispatch/active": (_req, url, ctx) =>
    handleDispatchActive(url, buildDispatchRoutesContext(ctx)),
  "GET /metrics": (_req, url, ctx) => handleMetricsRoute(url, buildMetricsRoutesContext(ctx)),
  "POST /mcp/tool": (req) => handleMcpToolRoute(req),
  "GET /api/hook-logs": (_req, url) => handleHookLogs(url),
  "GET /api/gh-rate-limit": () => handleGhRateLimit(),
  "GET /process/agents": () => handleProcessAgents(),
  "POST /process/agents/kill": (req) => handleProcessKill(req),
  "POST /sessions/delete": (req) => handleSessionDelete(req),
  "POST /projects/issues": (req, _url, ctx) =>
    handleProjectIssuesRoute(req, buildIssueRoutesContext(ctx)),
  "POST /projects/prs": (req, _url, ctx) =>
    handleProjectPrsRoute(req, buildIssueRoutesContext(ctx)),
  "POST /projects/sync-now": (req, _url, ctx) =>
    handleProjectSyncNow(req, buildIssueRoutesContext(ctx)),
  "GET /cache/status": (_req, _url, ctx) => handleCacheStatus(buildMetricsRoutesContext(ctx)),
  "POST /status-line/snapshot": (req, _url, ctx) =>
    handleStatusLineSnapshot(req, buildComplianceRoutesContext(ctx)),
  "POST /compliance/record": (req, _url, ctx) =>
    handleComplianceRecord(req, buildComplianceRoutesContext(ctx)),
  "GET /compliance/current": (_req, url, ctx) =>
    handleComplianceCurrent(url, buildComplianceRoutesContext(ctx)),
}

async function handleTopLevelRoutes(
  req: Request,
  url: URL,
  ctx: DaemonWebServerContext
): Promise<Response | null> {
  const key = `${req.method} ${url.pathname}`
  const handler = TOP_ROUTE_TABLE[key]
  if (!handler) return null
  return handler(req, url, ctx)
}

const DELEGATE_HANDLERS: Array<
  (req: Request, url: URL, ctx: DaemonWebServerContext) => Promise<Response | null>
> = [
  handleTopLevelRoutes,
  (req, url, ctx) => handleCacheRoutes(req, url, buildCacheRoutesContext(ctx)),
  (req, url, ctx) => handleCiRoutes(req, url, buildCiRoutesContext(ctx)),
  (req, url, ctx) => handleSettingsRoutes(req, url, buildSettingsRoutesContext(ctx)),
  (req, url, ctx) => handleSessionRoutes(req, url, buildSessionRoutesContext(ctx)),
]

async function handleFetchRoutes(
  req: Request,
  url: URL,
  ctx: DaemonWebServerContext
): Promise<Response> {
  for (const handler of DELEGATE_HANDLERS) {
    const response = await handler(req, url, ctx)
    if (response) return response
  }
  return new Response("Not Found", { status: 404 })
}

export function startDaemonWebServer(ctx: DaemonWebServerContext): DaemonWebServerHandle {
  const notFound = () => new Response("Not Found", { status: 404 })
  const server = Bun.serve({
    port: ctx.port,
    routes: {
      "/health": new Response("ok"),
      "/": async (req) => {
        if (req.method !== "GET") return notFound()
        return (await serveWebAsset("/")) ?? notFound()
      },
      "/web": async (req) => {
        if (req.method !== "GET") return notFound()
        return (await serveWebAsset("/web/index.html")) ?? notFound()
      },
      "/web/*": async (req) => {
        if (req.method !== "GET") return notFound()
        return (await serveWebAsset(new URL(req.url).pathname)) ?? notFound()
      },
      // Shared pure modules a web bundle imports as ../../<path>. Registered as exact paths, not
      // a /tasks/* wildcard: that wildcard shadowed POST /tasks/create and broke task creation.
      ...sharedModuleRoutes(notFound),
      "/public/*": async (req) => {
        if (req.method !== "GET") return notFound()
        const pathname = new URL(req.url).pathname
        const relative = pathname.replace(/^\/public\//, "").replace(/^\/+/, "")
        if (!relative || relative.includes("..")) return notFound()
        const filePath = join(PUBLIC_ROOT, relative)
        const file = Bun.file(filePath)
        if (!(await file.exists())) return notFound()
        const contentType = WEB_MIME_TYPES[extname(filePath)] ?? "application/octet-stream"
        return new Response(file, {
          headers: { "cache-control": "max-age=3600", "content-type": contentType },
        })
      },
      "/favicon.ico": async (req) => {
        if (req.method !== "GET") return notFound()
        return (await serveWebAsset("/web/favicon.ico")) ?? new Response(null, { status: 204 })
      },
    },
    async fetch(req) {
      ctx.pruneTranscriptMemory()
      reapStaleDispatches(ctx.activeHookDispatches)
      const url = new URL(req.url)
      return handleFetchRoutes(req, url, ctx)
    },
  })
  return server
}
