import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveProjectRoot } from "../../project-identity.ts"
import { ManifestCache, ProjectSettingsCache } from "./runtime-cache.ts"
import { handleScopedSettingsRoutes } from "./scoped-settings-routes.ts"

const roots: string[] = []
let home: string
let cwd: string
let invalidations: string[]
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "scoped-settings-"))
  roots.push(home)
  cwd = join(home, "project")
  await mkdir(join(home, ".swiz"), { recursive: true })
  await mkdir(join(cwd, ".swiz"), { recursive: true })
  cwd = await resolveProjectRoot(cwd)
  invalidations = []
})
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

async function request(body: object, update = false) {
  const projectSettingsCache = new ProjectSettingsCache()
  projectSettingsCache.invalidateProject = (path) => {
    invalidations.push(path)
  }
  const ctx = {
    touchProject: () => {},
    registerProjectWatchers: () => {},
    projectSettingsCache,
    manifestCache: new ManifestCache(projectSettingsCache),
  }
  const req = new Request(`http://daemon/settings/scoped${update ? "/update" : ""}`, {
    method: "POST",
    body: JSON.stringify(body),
  })
  return (await handleScopedSettingsRoutes(req, new URL(req.url), ctx, { home }))!
}

describe("scoped settings", () => {
  test("reports project, explicit global and default sources per value", async () => {
    await Bun.write(
      join(home, ".swiz/settings.json"),
      JSON.stringify({ autoContinue: true, prMergeMode: false })
    )
    await Bun.write(
      join(cwd, ".swiz/config.json"),
      JSON.stringify({ autoContinue: false, trunkMode: true, prMergeMode: true })
    )
    const result = await (await request({ scope: "project", cwd })).json()
    const byKey = Object.fromEntries(result.settings.map((s: { key: string }) => [s.key, s]))
    expect(byKey.autoContinue).toMatchObject({
      value: false,
      source: "project",
      inheritedValue: true,
      inheritedSource: "user",
    })
    expect(byKey.prMergeMode).toMatchObject({ value: false, source: "user", editable: false })
    expect(byKey.trunkMode).toMatchObject({ value: true, source: "project", inheritedValue: false })
    expect(byKey.ci).toMatchObject({ value: true, source: "default" })
    expect(result.path).toBe(join(cwd, ".swiz/config.json"))
  })

  test("global view excludes project-only settings", async () => {
    const result = await (await request({ scope: "global" })).json()
    expect(result.settings.some((s: { key: string }) => s.key === "trunkMode")).toBe(false)
    expect(
      result.settings.find((s: { key: string }) => s.key === "ambitionMode").choices
    ).toContain("reflective")
  })

  test("project reset removes the key, preserves unrelated data and takes a backup", async () => {
    const file = join(cwd, ".swiz/config.json")
    const original = JSON.stringify({
      autoContinue: false,
      trunkMode: true,
      custom: { keep: true },
    })
    await Bun.write(file, original)
    await Bun.write(join(home, ".swiz/settings.json"), JSON.stringify({ autoContinue: true }))
    const result = await request(
      { scope: "project", cwd, key: "autoContinue", inherit: true },
      true
    )
    expect(result.status).toBe(200)
    expect(await Bun.file(file).json()).toEqual({ trunkMode: true, custom: { keep: true } })
    expect(await Bun.file(`${file}.bak`).text()).toBe(original)
    const body = await result.json()
    expect(body.settings.find((s: { key: string }) => s.key === "autoContinue")).toMatchObject({
      value: true,
      source: "user",
    })
    expect(invalidations).toContain(cwd)
  })

  test("scope violations never change global settings from a project edit", async () => {
    expect(
      (await request({ scope: "project", cwd, key: "prMergeMode", value: false }, true)).status
    ).toBe(400)
    expect((await request({ scope: "global", key: "trunkMode", value: true }, true)).status).toBe(
      400
    )
    expect(await Bun.file(join(home, ".swiz/settings.json")).exists()).toBe(false)
  })

  test("validates booleans, numeric bounds, enums, and required paths before writing", async () => {
    for (const body of [
      { scope: "global", key: "autoContinue", value: "true" },
      { scope: "global", key: "transcriptMonitorMaxConcurrentDispatches", value: 65 },
      { scope: "project", cwd, key: "ambitionMode", value: "anything" },
      { scope: "project", cwd, key: "autoContinue", value: true, inherit: true },
      { scope: "global", key: "autoContinue", inherit: true },
      { scope: "project", key: "autoContinue", value: true },
      { scope: "project", cwd: ".", key: "autoContinue", value: true },
      { scope: "global", key: "unknown", value: true },
    ])
      expect((await request(body, true)).status).toBe(400)
    expect(await Bun.file(join(home, ".swiz/settings.json")).exists()).toBe(false)
    expect(await Bun.file(join(cwd, ".swiz/config.json")).exists()).toBe(false)
  })

  test("supports previously broken global auto steer and project trunk mode edits", async () => {
    expect((await request({ scope: "global", key: "autoSteer", value: true }, true)).status).toBe(
      200
    )
    expect((await Bun.file(join(home, ".swiz/settings.json")).json()).autoSteer).toBe(true)
    const result = await (
      await request({ scope: "project", cwd, key: "trunkMode", value: true }, true)
    ).json()
    expect(result.settings.find((s: { key: string }) => s.key === "trunkMode")).toMatchObject({
      value: true,
      source: "project",
    })
  })

  test("preserves malformed project files and returns a useful save error", async () => {
    const file = join(cwd, ".swiz/config.json")
    await Bun.write(file, "{broken")
    const response = await request({ scope: "project", cwd, key: "trunkMode", value: true }, true)
    expect(response.status).toBe(500)
    expect((await response.json()).error).toContain("Invalid project settings")
    expect(await Bun.file(file).text()).toBe("{broken")
  })
})
