import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { mcpToolResultSchema, runMcpTool } from "../mcp-tool-core.ts"
import { useTempDir } from "../utils/test-utils.ts"
import { handleMcpToolRoute } from "./daemon/mcp-tool-routes.ts"
import { executeMcpTool, registerSkillQueryTool, resetMcpToolDaemonBackoff } from "./mcp.ts"

const tmp = useTempDir("swiz-skill-query-")
const originalHome = process.env.HOME
const originalNoDaemon = process.env.SWIZ_NO_DAEMON
const body = "---\ndescription: Project review\n---\n# Review\n!`git status`\n"
let cwd: string
let localPath: string
let spawn: ReturnType<typeof spyOn<typeof Bun, "spawn">>
let spawnSync: ReturnType<typeof spyOn<typeof Bun, "spawnSync">>
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>

function mockFetch(handler: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>) {
  return Object.assign(handler, { preconnect: () => {} })
}

async function writeSkill(root: string, name: string, content: string): Promise<string> {
  const dir = join(root, name)
  await mkdir(dir, { recursive: true })
  const path = join(dir, "SKILL.md")
  await Bun.write(path, content)
  return path
}

beforeEach(async () => {
  const home = await tmp.create()
  cwd = join(home, "project")
  localPath = await writeSkill(join(cwd, ".skills"), "review", body)
  await writeSkill(join(home, ".agents", "skills"), "review", "# Global duplicate\n")
  await writeSkill(join(home, ".agents", "skills"), "global-only", "# Shared skill\n")
  process.env.HOME = home
  delete process.env.SWIZ_NO_DAEMON
  resetMcpToolDaemonBackoff()
  spawn = spyOn(Bun, "spawn").mockImplementation(() => {
    throw new Error("Unexpected subprocess")
  })
  spawnSync = spyOn(Bun, "spawnSync").mockImplementation(() => {
    throw new Error("Unexpected subprocess")
  })
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    mockFetch(async () => {
      throw new Error("Daemon unavailable")
    })
  )
})

afterEach(() => {
  spawn.mockRestore()
  spawnSync.mockRestore()
  fetchSpy.mockRestore()
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  if (originalNoDaemon === undefined) delete process.env.SWIZ_NO_DAEMON
  else process.env.SWIZ_NO_DAEMON = originalNoDaemon
  resetMcpToolDaemonBackoff()
})

function routeRequest(input: object, project = cwd): Request {
  return new Request("http://localhost/mcp/tool", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tool: "SkillQuery", input, cwd: project }),
  })
}

describe("SkillQuery MCP", () => {
  test("daemon route uses the caller's project and CLI precedence", async () => {
    const response = await handleMcpToolRoute(routeRequest({}))
    expect(response.status).toBe(200)
    const result = mcpToolResultSchema.parse(await response.json())
    expect(result.isError).toBeUndefined()
    const index = result.structuredContent?.skillQuery
    if (index?.action !== "list") throw new Error("Expected index")
    expect(index.skills.map((skill) => skill.name)).toEqual(["review", "global-only"])
    expect(index.skills[0]).toMatchObject({
      path: localPath,
      source: "local",
      description: "Project review",
    })
    expect(index.skills[1]?.source).toBe("global")
    const other = await tmp.create()
    const otherResult = await runMcpTool("SkillQuery", { name: "review" }, other)
    expect(otherResult.structuredContent?.skillQuery).toMatchObject({
      content: "# Global duplicate\n",
    })
  })

  test("reads project .agents skills without executing setup or Git", async () => {
    const path = await writeSkill(join(cwd, ".agents", "skills"), "agent-skill", body)
    const result = await runMcpTool("SkillQuery", { name: "agent-skill" }, cwd)
    expect(result.structuredContent?.skillQuery).toMatchObject({
      action: "read",
      skill: { path },
      content: body,
    })
    expect(spawn).not.toHaveBeenCalled()
    expect(spawnSync).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test("falls back locally after a daemon failure", async () => {
    const result = await executeMcpTool("SkillQuery", { name: "review" }, cwd)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(result.structuredContent?.skillQuery).toMatchObject({ action: "read", content: body })
    expect(result.content).toEqual([{ type: "text", text: body }])
    expect(spawn).not.toHaveBeenCalled()
  })

  test("supports explicitly disabled daemon transport", async () => {
    process.env.SWIZ_NO_DAEMON = "1"
    const result = await executeMcpTool("SkillQuery", { action: "lookup", name: "review" }, cwd)
    expect(result.structuredContent?.skillQuery).toMatchObject({
      action: "lookup",
      skill: { path: localPath },
    })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test("preserves structured daemon results and forwards the requested project", async () => {
    fetchSpy.mockImplementation(
      mockFetch(async (_url, init) => {
        expect(JSON.parse(String(init?.body))).toEqual({
          tool: "SkillQuery",
          input: { name: "review" },
          cwd,
        })
        return handleMcpToolRoute(routeRequest({ name: "review" }))
      })
    )
    const result = await executeMcpTool("SkillQuery", { name: "review" }, cwd)
    expect(result.structuredContent?.skillQuery).toMatchObject({ action: "read", content: body })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  test("returns MCP errors for invalid input and unknown names", async () => {
    for (const input of [{ action: "read" }, { name: "missing" }, { action: "transfer" }]) {
      const result = mcpToolResultSchema.parse(
        await (await handleMcpToolRoute(routeRequest(input))).json()
      )
      expect(result.isError).toBe(true)
      expect(result.content[0]?.text).toContain("SkillQuery failed:")
    }
  })

  test("advertises and calls SkillQuery through the MCP protocol", async () => {
    process.env.SWIZ_NO_DAEMON = "1"
    const server = new McpServer({ name: "swiz-test", version: "0" })
    const client = new Client({ name: "test-client", version: "0" })
    registerSkillQueryTool(server, cwd)
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    try {
      const { tools } = await client.listTools()
      expect(tools.map((tool) => tool.name)).toEqual(["SkillQuery"])
      expect(tools[0]?.annotations?.readOnlyHint).toBe(true)
      expect(tools[0]?.inputSchema.properties).toHaveProperty("name")
      const result = await client.callTool({ name: "SkillQuery", arguments: { name: "review" } })
      expect(result.isError).toBeUndefined()
      expect(result.structuredContent).toMatchObject({
        skillQuery: { action: "read", content: body },
      })
      const invalid = await client.callTool({ name: "SkillQuery", arguments: { action: "read" } })
      expect(invalid.isError).toBe(true)
    } finally {
      await client.close()
      await server.close()
    }
  })
})
