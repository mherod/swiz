import { describe, expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

// PROCESS_CONTRACT_TEST: verifies direct entrypoint guard and MCP stdio handshake boundaries.
const INDEX_PATH = join(import.meta.dir, "../../index.ts")
const MCP_INITIALIZE_REQUEST = `${JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "entrypoint-guard-test", version: "0" },
  },
})}\n`

describe("index.ts invocation guard", () => {
  test("direct invocation without SWIZ_DIRECT is blocked", async () => {
    const proc = Bun.spawn(["bun", "run", INDEX_PATH, "help"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        SWIZ_DIRECT: undefined,
      },
    })

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    await proc.exited

    expect(proc.exitCode).toBe(1)
    expect(stdout).toBe("")
    expect(stderr).toContain("Error: swiz must be invoked via the globally linked command.")
    expect(stderr).toContain("Run: swiz <command>")
  })

  test("direct invocation with SWIZ_DIRECT=1 succeeds", async () => {
    const proc = Bun.spawn(["bun", "run", INDEX_PATH, "help"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        SWIZ_DIRECT: "1",
      },
    })

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    await proc.exited

    expect(proc.exitCode).toBe(0)
    expect(stdout).toContain("swiz - CLI toolkit")
    expect(stderr).toBe("")
  })

  test("stdio MCP launch allows an inherited non-swiz underscore", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "swiz-mcp-entrypoint-"))
    const proc = Bun.spawn(["bun", "run", INDEX_PATH, "mcp"], {
      cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        _: "/Applications/Codex.app/Contents/MacOS/Codex",
        HOME: cwd,
        SWIZ_DIRECT: undefined,
      },
    })

    await proc.stdin.write(MCP_INITIALIZE_REQUEST)
    await proc.stdin.flush()
    await proc.stdin.end()

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    await proc.exited

    expect(proc.exitCode).toBe(0)
    const response = JSON.parse(stdout.trim())
    expect(response.id).toBe(1)
    expect(response.result.serverInfo.name).toBe("swiz")
    expect(stderr).toContain("swiz mcp server ready")
    expect(stderr).not.toContain("globally linked command")
  })
})
