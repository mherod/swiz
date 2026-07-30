/**
 * CI watching route handlers for the daemon web server.
 * Extracted from web-server.ts (issue #685) to keep routing code focused.
 */
import { readSwizSettings } from "../../settings.ts"
import type { CiWatchRegistry } from "./ci-watch-registry.ts"
import { verifyWebhookSignature } from "./ci-watch-registry.ts"
import { registerProjectAndTouch } from "./route-helpers.ts"

export interface CiRoutesContext {
  ciWatchRegistry: CiWatchRegistry
  touchProject: (cwd: string) => void
  registerProjectWatchers: (cwd: string) => void
}

async function handleCiWatchPost(req: Request, ctx: CiRoutesContext): Promise<Response> {
  const body = (await req.json().catch(() => null)) as { cwd?: string; sha?: string } | null
  if (typeof body?.cwd !== "string" || !body.cwd || typeof body?.sha !== "string" || !body.sha) {
    return Response.json(
      { error: "Missing required fields: cwd (string), sha (string)" },
      { status: 400 }
    )
  }
  const global = await readSwizSettings()
  if (global.ignoreCi) {
    return Response.json({ ignored: true })
  }
  const projectCwd = (await registerProjectAndTouch(ctx, body.cwd)) ?? body.cwd
  const started = ctx.ciWatchRegistry.start(projectCwd, body.sha)
  return Response.json(started)
}

type WebhookWorkflowRun = {
  head_sha?: string
  conclusion?: string | null
  id?: number
  status?: string
}

function parseWebhookPayload(
  rawBody: ArrayBuffer
): { run: WebhookWorkflowRun } | { error: string } {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(rawBody)) as {
      workflow_run?: WebhookWorkflowRun
    }
    const run = parsed.workflow_run
    if (!run) return { error: "no workflow_run in payload" }
    return { run }
  } catch {
    return { error: "Invalid JSON payload" }
  }
}

function webhookPayloadErrorResponse(error: string): Response {
  if (error === "Invalid JSON payload") {
    return Response.json({ error }, { status: 400 })
  }
  return Response.json({ ignored: true, reason: error })
}

async function checkWebhookSignature(req: Request, rawBody: ArrayBuffer): Promise<Response | null> {
  const webhookSecret = (await readSwizSettings()).githubWebhookSecret
  if (!webhookSecret) return null
  const sig = req.headers.get("X-Hub-Signature-256")
  const valid = await verifyWebhookSignature(webhookSecret, rawBody, sig)
  return valid ? null : Response.json({ error: "Invalid signature" }, { status: 401 })
}

function extractCompletedRun(
  run: WebhookWorkflowRun
): { sha: string; conclusion: string; runId: number } | null {
  const sha = run.head_sha
  const status = (run.status ?? "").toLowerCase()
  const conclusion = (run.conclusion ?? "").toLowerCase()
  if (!sha || status !== "completed" || !conclusion) return null
  return { sha, conclusion, runId: run.id ?? 0 }
}

async function handleCiWebhookPost(req: Request, ctx: CiRoutesContext): Promise<Response> {
  const event = req.headers.get("X-GitHub-Event")
  if (event !== "workflow_run") {
    return Response.json({ ignored: true, reason: "not a workflow_run event" })
  }

  const rawBody = await req.arrayBuffer()
  const sigError = await checkWebhookSignature(req, rawBody)
  if (sigError) return sigError

  const parsed = parseWebhookPayload(rawBody)
  if ("error" in parsed) return webhookPayloadErrorResponse(parsed.error)

  const completed = extractCompletedRun(parsed.run)
  if (!completed) return Response.json({ ignored: true, reason: "run not yet completed" })

  const { sha, conclusion, runId } = completed
  const resolved = await ctx.ciWatchRegistry.handleWebhookConclusion(sha, conclusion, runId)
  return Response.json({ resolved, sha, conclusion, runId })
}

export async function handleCiRoutes(
  req: Request,
  url: URL,
  ctx: CiRoutesContext
): Promise<Response | null> {
  if (url.pathname === "/ci-watch" && req.method === "POST") {
    return handleCiWatchPost(req, ctx)
  }
  if (url.pathname === "/ci-watch/webhook" && req.method === "POST") {
    return handleCiWebhookPost(req, ctx)
  }
  if (url.pathname === "/ci-watches" && req.method === "GET") {
    const cwd = url.searchParams.get("cwd")
    const active = ctx.ciWatchRegistry
      .listActive()
      .filter((entry) => (cwd ? entry.cwd === cwd : true))
    return Response.json({ active })
  }
  return null
}
