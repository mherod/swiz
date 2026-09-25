import { afterAll, describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { projectKeyFromCwd } from "../project-key.ts"

// End-to-end coverage for swiz#955: the real `swiz mcp` server, launched from "/" the way
// the Claude desktop app launches it, must follow the client's MCP roots. Everything it
// writes goes to a temp HOME and TMPDIR.

const clients: Client[] = []
afterAll(async () => {
  for (const client of clients) await client.close().catch(() => {})
})

async function startRootedServer(root: { current: string }) {
  const home = await mkdtemp(join(tmpdir(), "swiz-mcp-roots-home-"))
  const tmp = await mkdtemp(join(tmpdir(), "swiz-mcp-roots-tmp-"))
  await mkdir(join(home, ".swiz"), { recursive: true })
  // mcpChannels starts the drain loop, which writes the channel status file.
  await Bun.write(join(home, ".swiz", "settings.json"), JSON.stringify({ mcpChannels: true }))
  const transport = new StdioClientTransport({
    command: "bun",
    args: [join(process.cwd(), "index.ts"), "mcp"],
    cwd: "/",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home,
      TMPDIR: tmp,
      SWIZ_DIRECT: "1",
      SWIZ_NO_DAEMON: "1",
      AI_TEST_NO_BACKEND: "1",
    },
    stderr: "pipe",
  })
  const client = new Client(
    { name: "roots-e2e", version: "0" },
    { capabilities: { roots: { listChanged: true } } }
  )
  client.setRequestHandler(ListRootsRequestSchema, () => ({
    roots: [{ uri: pathToFileURL(root.current).href }],
  }))
  clients.push(client)
  await client.connect(transport)
  return { client, home, tmp }
}

async function statusFor(tmp: string, projectDir: string) {
  const path = join(tmp, `swiz-mcp-channel-${projectKeyFromCwd(projectDir)}.status.json`)
  for (let attempt = 0; attempt < 50; attempt++) {
    const file = Bun.file(path)
    if (await file.exists()) return (await file.json()) as { cwd: string; cwdSource: string }
    await Bun.sleep(100)
  }
  return null
}

async function taskStores(home: string): Promise<string[]> {
  return (await readdir(join(home, ".claude", "tasks")).catch(() => [] as string[])).sort()
}

describe("swiz mcp roots resolution (end to end)", () => {
  it("records cwdSource and follows notifications/roots/list_changed", async () => {
    const first = await mkdtemp(join(tmpdir(), "swiz-mcp-roots-a-"))
    const second = await mkdtemp(join(tmpdir(), "swiz-mcp-roots-b-"))
    const root = { current: first }
    const { client, home, tmp } = await startRootedServer(root)

    // AC5: the drain loop's status file names the resolved directory and its source.
    expect(await statusFor(tmp, first)).toMatchObject({ cwd: first, cwdSource: "roots" })

    await client.callTool({
      name: "TaskCreate",
      arguments: { subject: "Probe the first root", description: "note: e2e" },
    })
    expect(await taskStores(home)).toEqual([projectKeyFromCwd(first)])

    // AC4: after the client's roots move, later task calls use the new project key.
    root.current = second
    await client.sendRootsListChanged()
    expect(await statusFor(tmp, second)).toMatchObject({ cwd: second, cwdSource: "roots" })
    await client.callTool({
      name: "TaskCreate",
      arguments: { subject: "Probe the second root", description: "note: e2e" },
    })
    expect(await taskStores(home)).toEqual(
      [projectKeyFromCwd(first), projectKeyFromCwd(second)].sort()
    )
    // Control: nothing was ever written to the shared "-" store.
    expect(await taskStores(home)).not.toContain("-")
  }, 30000)
})
