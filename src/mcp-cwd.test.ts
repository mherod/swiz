import { describe, expect, it } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import {
  createMcpCwdResolver,
  type McpRootsServer,
  resolveMcpCwd,
  unresolvedMcpCwdMessage,
} from "./mcp-cwd.ts"

function fakeServer(roots: string[] | null, fail = false): McpRootsServer {
  return {
    getClientCapabilities: () => (roots === null ? {} : { roots: { listChanged: true } }),
    listRoots: async () => {
      if (fail) throw new Error("roots/list failed")
      return { roots: (roots ?? []).map((uri) => ({ uri })) }
    },
  }
}

describe("resolveMcpCwd", () => {
  it("uses the first file:// root that is a directory", async () => {
    const project = await mkdtemp(join(tmpdir(), "swiz-mcp-root-"))
    const missing = pathToFileURL(join(project, "missing")).href
    const server = fakeServer(["https://example.test/repo", missing, pathToFileURL(project).href])
    expect(await resolveMcpCwd(server, "/")).toEqual({ cwd: project, source: "roots" })
  })

  it("falls back to the process cwd when roots are absent, unusable or failing", async () => {
    const processCwd = await mkdtemp(join(tmpdir(), "swiz-mcp-process-"))
    for (const server of [
      fakeServer(null),
      fakeServer([]),
      fakeServer(["https://example.test/repo"]),
      fakeServer([pathToFileURL(processCwd).href], true),
    ]) {
      expect(await resolveMcpCwd(server, processCwd)).toEqual({
        cwd: processCwd,
        source: "process",
      })
    }
  })

  it("never resolves the filesystem root, which would share one queue across projects", async () => {
    expect(await resolveMcpCwd(fakeServer(null), "/")).toEqual({ cwd: null, source: "unresolved" })
    expect(await resolveMcpCwd(fakeServer([]), "/")).toEqual({ cwd: null, source: "unresolved" })
  })
})

describe("createMcpCwdResolver", () => {
  it("caches the latest resolution until refreshed", async () => {
    const first = await mkdtemp(join(tmpdir(), "swiz-mcp-first-"))
    const second = await mkdtemp(join(tmpdir(), "swiz-mcp-second-"))
    let roots = [pathToFileURL(first).href]
    let calls = 0
    const resolver = createMcpCwdResolver(
      {
        getClientCapabilities: () => ({ roots: {} }),
        listRoots: async () => {
          calls += 1
          return { roots: roots.map((uri) => ({ uri })) }
        },
      },
      "/"
    )
    expect((await resolver.current()).cwd).toBe(first)
    expect((await resolver.current()).cwd).toBe(first)
    expect(calls).toBe(1)
    roots = [pathToFileURL(second).href]
    expect((await resolver.refresh()).cwd).toBe(second)
    expect((await resolver.current()).cwd).toBe(second)
  })
})

describe("roots over the MCP protocol", () => {
  it("resolves the directory a roots-capable client reports", async () => {
    const project = await mkdtemp(join(tmpdir(), "swiz-mcp-client-root-"))
    const server = new McpServer({ name: "swiz-test", version: "0" })
    const client = new Client(
      { name: "test-client", version: "0" },
      { capabilities: { roots: { listChanged: true } } }
    )
    client.setRequestHandler(ListRootsRequestSchema, () => ({
      roots: [{ uri: pathToFileURL(project).href, name: "project" }],
    }))
    const lowLevel = (server as unknown as { server: McpRootsServer }).server
    const resolver = createMcpCwdResolver(lowLevel, "/")
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    try {
      expect(await resolver.refresh()).toEqual({ cwd: project, source: "roots" })
    } finally {
      await client.close()
      await server.close()
    }
  })

  it("reports unresolved for a client without roots when launched from /", async () => {
    const server = new McpServer({ name: "swiz-test", version: "0" })
    const client = new Client({ name: "test-client", version: "0" })
    const lowLevel = (server as unknown as { server: McpRootsServer }).server
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    try {
      expect(await createMcpCwdResolver(lowLevel, "/").refresh()).toEqual({
        cwd: null,
        source: "unresolved",
      })
    } finally {
      await client.close()
      await server.close()
    }
  })
})

describe("unresolvedMcpCwdMessage", () => {
  it("names the tool, the cause and the tracking issue", () => {
    const message = unresolvedMcpCwdMessage("TaskCreate")
    expect(message).toStartWith("TaskCreate failed:")
    expect(message).toContain('cwd "/"')
    expect(message).toContain("swiz#955")
  })
})
