/**
 * Process management route handlers for the daemon web server.
 * Extracted from web-server.ts (issue #685) to keep routing code focused.
 */
import { deleteSessionData, resolveSessionDeletionTargets } from "../../session-data-delete.ts"
import {
  getActiveAgentProcesses,
  getCachedAgentProcesses,
  getProcessCommand,
  isCursorMacProcess,
} from "./agent-process-discovery.ts"

export async function handleProcessKill(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => null)) as { pid?: number } | null
  const pid = body?.pid
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 1) {
    return Response.json(
      { error: "Missing required field: pid (positive integer)" },
      { status: 400 }
    )
  }
  const command = await getProcessCommand(pid)
  const killCommand = isCursorMacProcess(command ?? "")
    ? ["osascript", "-e", 'tell application "Cursor" to quit']
    : ["kill", "-TERM", String(pid)]
  const killProc = Bun.spawn(killCommand, { stdout: "pipe", stderr: "pipe" })
  const stderr = await new Response(killProc.stderr).text()
  await killProc.exited
  if (killProc.exitCode !== 0) {
    return Response.json(
      { error: stderr.trim() || `Failed to terminate pid ${pid}` },
      { status: 500 }
    )
  }
  return Response.json({ ok: true, pid })
}

function findBlockedProviders(
  sessions: Array<{ provider?: string }>,
  activeProcesses: { providers: Record<string, number[]> }
): Map<string, number[]> {
  const blocked = new Map<string, number[]>()
  for (const session of sessions) {
    const provider = (session.provider ?? "unknown").toLowerCase()
    const pids = activeProcesses.providers[provider] ?? []
    if (pids.length > 0) blocked.set(provider, pids)
  }
  return blocked
}

export async function handleSessionDelete(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => null)) as {
    cwd?: string
    sessionId?: string
  } | null
  if (typeof body?.cwd !== "string" || !body.cwd || typeof body?.sessionId !== "string") {
    return Response.json(
      { error: "Missing required fields: cwd (string), sessionId (string)" },
      { status: 400 }
    )
  }
  const targets = await resolveSessionDeletionTargets(body.cwd, body.sessionId)
  if (targets.matchedSessions.length === 0) {
    return Response.json({ error: `Session ${body.sessionId} not found` }, { status: 404 })
  }
  const activeProcesses = await getActiveAgentProcesses()
  const blocked = findBlockedProviders(targets.matchedSessions, activeProcesses)
  if (blocked.size > 0) {
    return Response.json(
      {
        error: "Cannot delete session while provider process is active",
        providers: Object.fromEntries(blocked),
      },
      { status: 409 }
    )
  }
  const result = await deleteSessionData(targets)
  if (result.failedPaths.length > 0) {
    return Response.json(
      { error: "Failed to delete one or more session paths", failedPaths: result.failedPaths },
      { status: 500 }
    )
  }
  return Response.json({
    ok: true,
    deletedCount: result.deletedCount,
    sessionIds: result.sessionIds,
  })
}

export async function handleProcessAgents(): Promise<Response> {
  try {
    return Response.json(await getCachedAgentProcesses())
  } catch (error) {
    return Response.json(
      {
        error: error instanceof Error ? error.message : "Failed to inspect active agent processes",
      },
      { status: 500 }
    )
  }
}
