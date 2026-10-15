/** Scope-aware settings inspection and single-setting edits for native clients. */
import { z } from "zod"
import {
  getProjectSettingsPath,
  getSwizSettingsPath,
  readGlobalExplicitSettingKeys,
  readProjectSettings,
  readSwizSettings,
} from "../../settings/persistence.ts"
import { SETTINGS_REGISTRY } from "../../settings/registry.ts"
import { resolveSettingSourceTier } from "../../settings/resolution.ts"
import { SettingsStore } from "../../settings/store.ts"
import type { ProjectSwizSettings, SettingDef } from "../../settings/types.ts"
import { registerProjectAndTouch } from "./route-helpers.ts"
import type { SettingsRoutesContext } from "./settings-routes.ts"

const scopeSchema = z.object({
  scope: z.enum(["global", "project"]),
  cwd: z.string().startsWith("/").optional(),
})
const updateSchema = scopeSchema.extend({
  key: z.string(),
  value: z.union([z.boolean(), z.number(), z.string()]).optional(),
  inherit: z.boolean().optional(),
})
type Scope = z.infer<typeof scopeSchema>
type Update = z.infer<typeof updateSchema>

interface InspectionInputs {
  scope: Scope
  globalValues: Record<string, unknown>
  project: ProjectSwizSettings | null
  explicitKeys: Set<string>
}

function valueSchema(def: SettingDef): z.ZodTypeAny {
  if (def.zodSchema) return def.zodSchema
  if (def.kind === "boolean") return z.boolean()
  if (def.kind === "numeric")
    return z
      .number()
      .int()
      .min(def.default === 0 ? 0 : 1)
  return z.string().max(200)
}

async function inspectSettings(scope: Scope, home?: string) {
  const [global, project, explicitKeys] = await Promise.all([
    readSwizSettings({ home, strict: true }),
    scope.scope === "project" ? readProjectSettings(scope.cwd!, { strict: true }) : null,
    readGlobalExplicitSettingKeys(home),
  ])
  const settings = SETTINGS_REGISTRY.filter(
    (def) => scope.scope === "project" || def.scopes.includes("global")
  ).map((def) => settingEntry(def, { scope, globalValues: { ...global }, project, explicitKeys }))
  return {
    ...scope,
    path:
      scope.scope === "project" ? getProjectSettingsPath(scope.cwd!) : getSwizSettingsPath(home),
    settings,
    sessionOverrideCount: Object.keys(global.sessions).length,
  }
}

function settingValues(def: SettingDef, inputs: InspectionInputs) {
  const hasGlobal = def.scopes.includes("global")
  const hasProject = inputs.scope.scope === "project" && def.scopes.includes("project")
  const projectValues = inputs.project as Record<string, unknown> | null
  const inheritedValue = (hasGlobal ? inputs.globalValues[def.key] : def.default) ?? null
  const globalExplicitKeys = hasGlobal ? inputs.explicitKeys : new Set<string>()
  const inheritedSource = resolveSettingSourceTier(def.key, { globalExplicitKeys })
  const override = hasProject ? projectValues?.[def.key] : undefined
  return {
    value: override ?? inheritedValue,
    inheritedValue,
    inheritedSource,
    source: resolveSettingSourceTier(def.key, {
      globalExplicitKeys,
      projectSettings: hasProject ? inputs.project : null,
    }),
  }
}

function settingEntry(def: SettingDef, inputs: InspectionInputs) {
  return {
    key: def.key,
    kind: def.kind,
    description: def.docs?.description ?? "",
    explanation: def.docs?.effectExplanation ?? "",
    scopes: def.scopes,
    ...settingValues(def, inputs),
    editable: def.scopes.includes(inputs.scope.scope),
    choices: def.zodSchema instanceof z.ZodEnum ? def.zodSchema.options : [],
  }
}

function updateError(body: Update, def: SettingDef): string | null {
  if (!def.scopes.includes(body.scope)) return `${def.key} cannot be changed at ${body.scope} scope`
  if (body.inherit) {
    if (body.scope !== "project") return "Only project settings can inherit"
    if (body.value !== undefined) return "Specify either inherit or value, not both"
    return null
  }
  const parsed = valueSchema(def).safeParse(body.value)
  if (!parsed.success) return `${def.key}: ${parsed.error.issues.map((i) => i.message).join("; ")}`
  return def.validate?.(String(body.value)) ?? null
}

function validateUpdate(raw: unknown): Update | Response {
  const body = updateSchema.parse(raw)
  const def = SETTINGS_REGISTRY.find((entry) => entry.key === body.key)
  const error = def ? updateError(body, def) : "Unknown setting"
  return error ? Response.json({ error }, { status: 400 }) : body
}

async function requestScope(body: Scope, ctx: SettingsRoutesContext): Promise<Scope | Response> {
  if (body.scope === "global") return { scope: "global" }
  if (!body.cwd) {
    return Response.json({ error: "Project scope requires an absolute cwd" }, { status: 400 })
  }
  const cwd = await registerProjectAndTouch(ctx, body.cwd)
  if (!cwd) return Response.json({ error: "Cannot resolve project directory" }, { status: 400 })
  return { scope: "project", cwd }
}

async function applyUpdate(
  scope: Scope,
  update: Update,
  ctx: SettingsRoutesContext,
  home?: string
) {
  const store = new SettingsStore({ home })
  if (scope.scope === "global") {
    await store.setGlobal(update.key, update.value)
    return
  }
  // undefined removes this key during JSON serialization; never persist null as an override.
  await store.setProject(scope.cwd!, update.key, update.inherit ? undefined : update.value)
  ctx.projectSettingsCache.invalidateProject(scope.cwd!)
  ctx.manifestCache.invalidateProject(scope.cwd!)
}

async function performScopedRequest(
  req: Request,
  isUpdate: boolean,
  ctx: SettingsRoutesContext,
  options: { home?: string } = {}
): Promise<Response | null> {
  const raw: unknown = await req.json().catch(() => null)
  const parsed = (isUpdate ? updateSchema : scopeSchema).safeParse(raw)
  if (!parsed.success) return Response.json({ error: "Invalid settings request" }, { status: 400 })
  const update = isUpdate ? validateUpdate(raw) : null
  if (update instanceof Response) return update
  const scope = await requestScope(parsed.data, ctx)
  if (scope instanceof Response) return scope
  try {
    if (update) await applyUpdate(scope, update, ctx, options.home)
    return Response.json(await inspectSettings(scope, options.home))
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Unable to access settings" },
      { status: 500 }
    )
  }
}

export async function handleScopedSettingsRoutes(
  req: Request,
  url: URL,
  ctx: SettingsRoutesContext,
  options: { home?: string } = {}
): Promise<Response | null> {
  if (req.method !== "POST") return null
  if (!["/settings/scoped", "/settings/scoped/update"].includes(url.pathname)) return null
  return performScopedRequest(req, url.pathname.endsWith("/update"), ctx, options)
}
