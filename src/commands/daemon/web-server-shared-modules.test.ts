import { describe, expect, test } from "bun:test"
import { resolveSharedModulePath, SHARED_WEB_MODULES, sharedModuleRoutes } from "./web-server.ts"

const notFound = () => new Response("Not Found", { status: 404 })

describe("resolveSharedModulePath", () => {
  test("resolves each allowlisted module under src/", () => {
    for (const pathname of SHARED_WEB_MODULES) {
      const resolved = resolveSharedModulePath(pathname)
      expect(resolved).toContain(`/src${pathname}`)
    }
  })

  test("refuses a source module that is not allowlisted", () => {
    expect(resolveSharedModulePath("/tasks/task-repository.ts")).toBeNull()
    expect(resolveSharedModulePath("/settings.ts")).toBeNull()
  })

  test("refuses traversal attempts", () => {
    expect(resolveSharedModulePath("/../package.json")).toBeNull()
    expect(resolveSharedModulePath("/tasks/../../package.json")).toBeNull()
  })
})

describe("sharedModuleRoutes", () => {
  test("registers one exact path per allowlisted module", () => {
    const routes = sharedModuleRoutes(notFound)
    expect(Object.keys(routes).sort()).toEqual([...SHARED_WEB_MODULES].sort())
  })

  test("never registers a prefix wildcard — /tasks/* would shadow POST /tasks/create", () => {
    const routes = sharedModuleRoutes(notFound)
    for (const path of Object.keys(routes)) {
      expect(path).not.toContain("*")
    }
    expect(routes["/tasks/create"]).toBeUndefined()
  })

  test("serves an allowlisted module over GET", async () => {
    const routes = sharedModuleRoutes(notFound)
    const handler = routes["/tasks/task-topology.ts"]
    expect(handler).toBeDefined()
    const response = await handler!(new Request("http://localhost/tasks/task-topology.ts"))
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("javascript")
    // Transpiled, not raw TypeScript: the browser must be able to execute it.
    expect(await response.text()).not.toContain("export interface TopologyTask")
  })

  test("rejects non-GET so a same-path API route is never answered by the file server", async () => {
    const routes = sharedModuleRoutes(notFound)
    const response = await routes["/tasks/task-topology.ts"]!(
      new Request("http://localhost/tasks/task-topology.ts", { method: "POST" })
    )
    expect(response.status).toBe(404)
  })
})
