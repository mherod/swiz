import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { ManifestCache, ProjectSettingsCache } from "./runtime-cache.ts"
import type { SettingsRoutesContext } from "./settings-routes.ts"

const globalWrites: Array<{ key: string; value: unknown }> = []
const projectWrites: Array<{ cwd: string; updates: Record<string, unknown> }> = []
const swizWrites: Array<Record<string, unknown>> = []
let globalSettings: Record<string, unknown> = { prMergeMode: false }

void mock.module("../../settings.ts", () => ({
  readSwizSettings: async () => ({ ...globalSettings }),
  settingsStore: {
    setGlobal: async (key: string, value: unknown) => {
      globalWrites.push({ key, value })
      globalSettings[key] = value
    },
  },
  writeProjectSettings: async (cwd: string, updates: Record<string, unknown>) => {
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
