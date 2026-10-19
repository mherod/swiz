import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { ManifestCache, ProjectSettingsCache } from "./runtime-cache.ts"
import type { SettingsRoutesContext } from "./settings-routes.ts"

const globalWrites: Array<{ key: string; value: unknown }> = []
const projectWrites: Array<{ cwd: string; updates: Record<string, unknown> }> = []
const swizWrites: Array<Record<string, unknown>> = []
let globalSettings: Record<string, unknown> = { prMergeMode: false }
let projectWriteError: Error | undefined

void mock.module("../../settings.ts", () => ({
  readSwizSettings: async () => ({ ...globalSettings }),
  settingsStore: {
    setGlobal: async (key: string, value: unknown) => {
      globalWrites.push({ key, value })
      globalSettings[key] = value
    },
  },
  writeProjectSettings: async (cwd: string, updates: Record<string, unknown>) => {
    if (projectWriteError) throw projectWriteError
    projectWrites.push({ cwd, updates })
  },
  writeSwizSettings: async (settings: Record<string, unknown>) => {
    swizWrites.push(settings)
    globalSettings = { ...settings }
  },
}))

let routes: typeof import("./settings-routes.ts")

beforeAll(async () => {
  routes = await import("./settings-routes.ts")
})

beforeEach(() => {
  globalWrites.length = 0
  projectWrites.length = 0
  swizWrites.length = 0
  globalSettings = { prMergeMode: false }
  projectWriteError = undefined
})

function createContext(): SettingsRoutesContext {
  const projectSettingsCache = new ProjectSettingsCache()
  return {
    touchProject: () => {},
    registerProjectWatchers: () => {},
    projectSettingsCache,
    manifestCache: new ManifestCache(projectSettingsCache),
  }
}

function post(path: string, body: Record<string, unknown>): Request {
  return new Request(`http://daemon${path}`, {
    method: "POST",
    body: JSON.stringify(body),
  })
}

describe("settings routes", () => {
  test("refreshes both caches before returning the same project response as inspection", async () => {
    const ctx = createContext()
    const events: string[] = []
    const cached = await ctx.projectSettingsCache.get("/repo")
    ctx.projectSettingsCache.get = async (cwd) => {
      events.push(`read:${cwd}`)
      return cached
    }
    ctx.projectSettingsCache.invalidateProject = (cwd) => events.push(`settings:${cwd}`)
    ctx.manifestCache.invalidateProject = (cwd) => events.push(`manifest:${cwd}`)
    const update = post("/settings/project/update", {
      cwd: "/repo",
      updates: { autoContinue: true, prMergeMode: true },
    })
    const saved = await routes.handleSettingsRoutes(update, new URL(update.url), ctx)
    expect(events).toEqual(["settings:/repo", "manifest:/repo", "read:/repo"])
    events.length = 0
    const inspection = post("/settings/project", { cwd: "/repo" })
    const inspected = await routes.handleSettingsRoutes(inspection, new URL(inspection.url), ctx)
    expect(events).toEqual(["read:/repo"])
    expect(await saved?.json()).toEqual(await inspected?.json())
  })

  test("propagates project write errors before global updates", async () => {
    const ctx = createContext()
    projectWriteError = new Error(
      "Invalid project settings at /repo/.swiz/config.json. Repair the file."
    )
    const req = post("/settings/project/update", {
      cwd: "/repo",
      updates: { autoContinue: true, prMergeMode: true },
    })
    await expect(routes.handleSettingsRoutes(req, new URL(req.url), ctx)).rejects.toThrow(
      projectWriteError.message
    )
    expect(projectWrites).toEqual([])
    expect(swizWrites).toEqual([])
  })
  test("filters unsupported global updates", async () => {
    const ctx = createContext()
    const req = post("/settings/global/update", {
      updates: { unsupported: true },
    })

    const response = await routes.handleSettingsRoutes(req, new URL(req.url), ctx)

    expect(response?.status).toBe(400)
    expect(globalWrites).toEqual([])
  })

  test("applies only allowlisted global setting keys", async () => {
    const ctx = createContext()
    const req = post("/settings/global/update", {
      updates: { autoContinue: true, unsupported: "ignored" },
    })

    const response = await routes.handleSettingsRoutes(req, new URL(req.url), ctx)

    expect(response?.status).toBe(200)
    expect(globalWrites).toEqual([{ key: "autoContinue", value: true }])
  })

  test("round-trips hook humanising through the web API independently", async () => {
    const ctx = createContext()
    globalSettings = { autoSteer: false, humaniseAutoSteer: true }
    for (const value of [true, false]) {
      const req = post("/settings/global/update", { updates: { humaniseHookContext: value } })
      const response = await routes.handleSettingsRoutes(req, new URL(req.url), ctx)
      expect(response?.status).toBe(200)
      expect((await response!.json()).settings).toEqual({
        autoSteer: false,
        humaniseAutoSteer: true,
        humaniseHookContext: value,
      })
    }
    expect(globalWrites).toEqual([
      { key: "humaniseHookContext", value: true },
      { key: "humaniseHookContext", value: false },
    ])
  })

  test("rejects an invalid project collaboration mode", async () => {
    const ctx = createContext()
    const req = post("/settings/project/update", {
      cwd: "/repo",
      updates: { collaborationMode: "unsupported" },
    })

    const response = await routes.handleSettingsRoutes(req, new URL(req.url), ctx)

    expect(response?.status).toBe(400)
    expect(await response?.json()).toEqual({
      error: "collaborationMode must be one of: auto, solo, team, relaxed-collab",
    })
  })

  test("rejects non-boolean project fields", async () => {
    const ctx = createContext()
    const req = post("/settings/project/update", {
      cwd: "/repo",
      updates: { strictNoDirectMain: "yes" },
    })

    const response = await routes.handleSettingsRoutes(req, new URL(req.url), ctx)

    expect(response?.status).toBe(400)
    expect(await response?.json()).toEqual({ error: "strictNoDirectMain must be a boolean" })
  })

  test("splits project updates from the global PR merge setting", async () => {
    const ctx = createContext()
    const req = post("/settings/project/update", {
      cwd: "/repo",
      updates: { trivialMaxFiles: 4, prMergeMode: true },
    })

    const response = await routes.handleSettingsRoutes(req, new URL(req.url), ctx)

    expect(response?.status).toBe(200)
    expect(projectWrites).toEqual([{ cwd: "/repo", updates: { trivialMaxFiles: 4 } }])
    expect(swizWrites).toEqual([{ prMergeMode: true }])
  })

  test("accepts boolean autoContinue project setting update", async () => {
    const ctx = createContext()
    const req = post("/settings/project/update", {
      cwd: "/repo",
      updates: { autoContinue: false },
    })

    const response = await routes.handleSettingsRoutes(req, new URL(req.url), ctx)

    expect(response?.status).toBe(200)
    expect(projectWrites).toEqual([{ cwd: "/repo", updates: { autoContinue: false } }])
  })

  test("returns null for unmatched settings routes", async () => {
    const ctx = createContext()
    const req = new Request("http://daemon/not-settings")
    expect(await routes.handleSettingsRoutes(req, new URL(req.url), ctx)).toBeNull()
  })
})
