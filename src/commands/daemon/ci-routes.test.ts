import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test"
import type { CiRoutesContext } from "./ci-routes.ts"
import { CiWatchRegistry } from "./ci-watch-registry.ts"

const webhookSettings = {
  ignoreCi: false,
  githubWebhookSecret: "test-webhook-secret",
}

void mock.module("../../settings.ts", () => ({
  readSwizSettings: async () => webhookSettings,
}))

let routes: typeof import("./ci-routes.ts")
const registries: CiWatchRegistry[] = []

beforeAll(async () => {
  routes = await import("./ci-routes.ts")
})

afterAll(() => {
  for (const registry of registries.splice(0)) registry.close()
})

function createContext(): CiRoutesContext {
  const ciWatchRegistry = new CiWatchRegistry({
    fetchRun: async () => null,
    notify: async () => {},
  })
  registries.push(ciWatchRegistry)
  return {
    ciWatchRegistry,
    touchProject: () => {},
    registerProjectWatchers: () => {},
  }
}

async function signWebhook(body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(webhookSettings.githubWebhookSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))
  const hex = Array.from(new Uint8Array(mac))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
  return `sha256=${hex}`
}

describe("CI routes", () => {
  test("validates POST /ci-watch and registers a canonical watch", async () => {
    const ctx = createContext()
    const invalid = new Request("http://daemon/ci-watch", {
      method: "POST",
      body: JSON.stringify({ cwd: "/repo" }),
    })
    const valid = new Request("http://daemon/ci-watch", {
      method: "POST",
      body: JSON.stringify({ cwd: "/repo", sha: "abc123" }),
    })

    expect((await routes.handleCiRoutes(invalid, new URL(invalid.url), ctx))?.status).toBe(400)
    const response = await routes.handleCiRoutes(valid, new URL(valid.url), ctx)
    expect(await response?.json()).toMatchObject({
      deduped: false,
      watch: { cwd: "/repo", sha: "abc123" },
    })
  })

  test("lists active watches and filters by cwd", async () => {
    const ctx = createContext()
    ctx.ciWatchRegistry.start("/one", "sha-one")
    ctx.ciWatchRegistry.start("/two", "sha-two")
    const req = new Request("http://daemon/ci-watches?cwd=/two")

    const response = await routes.handleCiRoutes(req, new URL(req.url), ctx)
    if (!response) throw new Error("Expected GET /ci-watches response")
    const body = await response.json()

    expect(body.active).toEqual([expect.objectContaining({ cwd: "/two", sha: "sha-two" })])
  })

  test("ignores non-workflow webhook events", async () => {
    const ctx = createContext()
    const req = new Request("http://daemon/ci-watch/webhook", {
      method: "POST",
      headers: { "X-GitHub-Event": "push" },
      body: "{}",
    })

    expect(await routes.handleCiRoutes(req, new URL(req.url), ctx).then((r) => r?.json())).toEqual({
      ignored: true,
      reason: "not a workflow_run event",
    })
  })

  test("rejects a bad signature before parsing the webhook payload", async () => {
    const ctx = createContext()
    const req = new Request("http://daemon/ci-watch/webhook", {
      method: "POST",
      headers: {
        "X-GitHub-Event": "workflow_run",
        "X-Hub-Signature-256": "sha256=bad",
      },
      body: "{}",
    })

    expect((await routes.handleCiRoutes(req, new URL(req.url), ctx))?.status).toBe(401)
  })

  test("resolves a matching watch from a signed completed workflow payload", async () => {
    const ctx = createContext()
    ctx.ciWatchRegistry.start("/repo", "sha-complete")
    const body = JSON.stringify({
      workflow_run: {
        head_sha: "sha-complete",
        conclusion: "success",
        id: 77,
        status: "completed",
      },
    })
    const req = new Request("http://daemon/ci-watch/webhook", {
      method: "POST",
      headers: {
        "X-GitHub-Event": "workflow_run",
        "X-Hub-Signature-256": await signWebhook(body),
      },
      body,
    })

    const response = await routes.handleCiRoutes(req, new URL(req.url), ctx)

    expect(await response?.json()).toEqual({
      resolved: 1,
      sha: "sha-complete",
      conclusion: "success",
      runId: 77,
    })
    expect(ctx.ciWatchRegistry.listActive()).toEqual([])
  })

  test("returns null for unmatched method and path pairs", async () => {
    const ctx = createContext()
    const req = new Request("http://daemon/not-ci")
    expect(await routes.handleCiRoutes(req, new URL(req.url), ctx)).toBeNull()
  })
})
