import { describe, expect, it } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { handleMcpToolRoute } from "./mcp-tool-routes.ts"

function post(body: unknown): Request {
  return new Request("http://localhost/mcp/tool", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

describe("handleMcpToolRoute", () => {
  it("rejects a body without a known tool", async () => {
    const resp = await handleMcpToolRoute(post({ tool: "NotATool", cwd: "/x" }))
    expect(resp.status).toBe(400)
    expect(((await resp.json()) as { error?: string }).error).toContain("tool")
  })

  it("rejects a missing cwd", async () => {
    const resp = await handleMcpToolRoute(post({ tool: "TaskList" }))
    expect(resp.status).toBe(400)
    expect(((await resp.json()) as { error?: string }).error).toContain("cwd")
  })

  it("rejects malformed JSON", async () => {
    const resp = await handleMcpToolRoute(post("{not json"))
    expect(resp.status).toBe(400)
  })

  it("executes TaskList for a fresh project", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "swiz-mcp-route-"))
    const resp = await handleMcpToolRoute(post({ tool: "TaskList", cwd }))
    expect(resp.status).toBe(200)
    const result = (await resp.json()) as {
      content: Array<{ type: string; text: string }>
      isError?: boolean
    }
    expect(result.isError).toBeUndefined()
    expect(result.content[0]?.text).toContain("No tasks in this project yet.")
  })
})
