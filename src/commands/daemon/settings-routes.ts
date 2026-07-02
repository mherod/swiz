/**
 * Settings route handlers for the daemon web server.
 * Extracted from web-server.ts (issue #685) to keep routing code focused.
 */
import {
  readSwizSettings,
  settingsStore,
  writeProjectSettings,
  writeSwizSettings,
} from "../../settings.ts"
import { registerProjectAndTouch } from "./route-helpers.ts"
import type { ManifestCache, ProjectSettingsCache } from "./runtime-cache.ts"

export interface SettingsRoutesContext {
  touchProject: (cwd: string) => void
  registerProjectWatchers: (cwd: string) => void
  projectSettingsCache: ProjectSettingsCache
  manifestCache: ManifestCache
}

async function handleGlobalSettingsUpdate(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => null)) as { updates?: Record<string, any> } | null
  if (!body?.updates || typeof body.updates !== "object") {
    return Response.json({ error: "Missing required field: updates (object)" }, { status: 400 })
  }
  const validKeys = [
    "autoContinue",
    "critiquesEnabled",
    "prMergeMode",
    "pushGate",
    "sandboxedEdits",
    "speak",
    "swizNotifyHooks",
    "mcpChannels",
    "gitStatusGate",
    "ambitionMode",
    "memoryWordThreshold",
    "memoryLineThreshold",
    "transcriptMonitorMaxConcurrentDispatches",
  ]
  let updatedAny = false
  for (const key of validKeys) {
    if (key in body.updates) {
      await settingsStore.setGlobal(key, body.updates[key])
      updatedAny = true
    }
  }
  if (!updatedAny) {
    return Response.json({ error: "No supported updates provided" }, { status: 400 })
  }
  return Response.json({ success: true, settings: await readSwizSettings() })
}

async function handleProjectSettingsGet(
  req: Request,
  ctx: SettingsRoutesContext
): Promise<Response> {
  const body = (await req.json().catch(() => null)) as { cwd?: string } | null
  if (typeof body?.cwd !== "string" || !body.cwd) {
    return Response.json({ error: "Missing required field: cwd" }, { status: 400 })
  }
  registerProjectAndTouch(ctx, body.cwd)
  const cached = await ctx.projectSettingsCache.get(body.cwd)
  const globalSettings = await readSwizSettings()
  return Response.json({ ...cached, globalSettings: { prMergeMode: globalSettings.prMergeMode } })
}

async function applyProjectSettingsUpdates(
  cwd: string,
  normalized: Record<string, any>
): Promise<void> {
  const projectUpdates: Record<string, any> = {}
  for (const key of Object.keys(normalized)) {
    if (key !== "prMergeMode") projectUpdates[key] = normalized[key]
  }
  if (Object.keys(projectUpdates).length > 0) {
    await writeProjectSettings(cwd, projectUpdates)
  }
  if (normalized.prMergeMode !== undefined) {
    const gs = await readSwizSettings()
    await writeSwizSettings({
      ...gs,
      prMergeMode: normalized.prMergeMode as boolean,
    })
  }
}

function validateBooleanField(updates: Record<string, any>, key: string): string | null {
  if (key in updates && typeof updates[key] !== "boolean") {
    return `${key} must be a boolean`
  }
  return null
}

function normalizeProjectSettingsUpdates(
  updates: Record<string, any>
): Record<string, any> | { error: string } {
  const result: Record<string, any> = {}
  const validModes = new Set(["auto", "solo", "team", "relaxed-collab"])
  const optionalKeys = [
    "trivialMaxFiles",
    "trivialMaxLines",
    "defaultBranch",
    "memoryLineThreshold",
    "memoryWordThreshold",
    "largeFileSizeKb",
    "taskDurationWarningMinutes",
    "transcriptMonitorMaxConcurrentDispatches",
    "ambitionMode",
  ] as const

  if ("collaborationMode" in updates) {
    const mode = updates.collaborationMode
    if (!validModes.has(String(mode))) {
      return { error: "collaborationMode must be one of: auto, solo, team, relaxed-collab" }
    }
    result.collaborationMode = mode
  }

  for (const boolKey of [
    "prMergeMode",
    "strictNoDirectMain",
    "autoSteerTranscriptWatching",
    "speak",
  ] as const) {
    const err = validateBooleanField(updates, boolKey)
    if (err) return { error: err }
    if (boolKey in updates) result[boolKey] = updates[boolKey]
  }

  for (const key of optionalKeys) {
    if (key in updates) result[key] = updates[key]
  }
  return result
}

async function handleProjectSettingsUpdate(
  req: Request,
  ctx: SettingsRoutesContext
): Promise<Response> {
  const body = (await req.json().catch(() => null)) as {
    cwd?: string
    updates?: {
      collaborationMode?: "auto" | "solo" | "team" | "relaxed-collab"
      prMergeMode?: boolean
      strictNoDirectMain?: boolean
      trivialMaxFiles?: number | null
      trivialMaxLines?: number | null
      defaultBranch?: string | null
      memoryLineThreshold?: number | null
      memoryWordThreshold?: number | null
      largeFileSizeKb?: number | null
      ambitionMode?: "standard" | "aggressive" | "creative" | "reflective" | "inherit" | null
      taskDurationWarningMinutes?: number | null
      transcriptMonitorMaxConcurrentDispatches?: number | null
      autoSteerTranscriptWatching?: boolean
      speak?: boolean
    }
  } | null
  const cwd = body?.cwd
  const updates = body?.updates
  if (typeof cwd !== "string" || !cwd || !updates || typeof updates !== "object") {
    return Response.json(
      { error: "Missing required fields: cwd (string), updates (object)" },
      { status: 400 }
    )
  }

  const normalized = normalizeProjectSettingsUpdates(updates)
  if ("error" in normalized) {
    return Response.json({ error: normalized.error }, { status: 400 })
  }
  if (Object.keys(normalized).length === 0) {
    return Response.json({ error: "No supported updates provided" }, { status: 400 })
  }

  registerProjectAndTouch(ctx, cwd)
  await applyProjectSettingsUpdates(cwd, normalized)
  ctx.projectSettingsCache.invalidateProject(cwd)
  ctx.manifestCache.invalidateProject(cwd)
  const cached = await ctx.projectSettingsCache.get(cwd)
  const globalSettings = await readSwizSettings()
  return Response.json({ ...cached, globalSettings: { prMergeMode: globalSettings.prMergeMode } })
}

export async function handleSettingsRoutes(
  req: Request,
  url: URL,
  ctx: SettingsRoutesContext
): Promise<Response | null> {
  if (url.pathname === "/settings/global" && req.method === "GET") {
    return Response.json({ settings: await readSwizSettings() })
  }
  if (url.pathname === "/settings/global/update" && req.method === "POST") {
    return handleGlobalSettingsUpdate(req)
  }
  if (url.pathname === "/settings/project" && req.method === "POST") {
    return handleProjectSettingsGet(req, ctx)
  }
  if (url.pathname === "/settings/project/update" && req.method === "POST") {
    return handleProjectSettingsUpdate(req, ctx)
  }
  return null
}
