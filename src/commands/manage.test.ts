import { describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseManageArgs } from "./manage.ts"

const INDEX_PATH = join(import.meta.dir, "..", "..", "index.ts")

async function makeTempHome(prefix = "swiz-manage-test-"): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix))
}

async function runManage(
  args: string[],
  home: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", INDEX_PATH, "manage", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HOME: home },
  })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited
  return { stdout, stderr, exitCode: proc.exitCode ?? 1 }
}

describe("parseManageArgs", () => {
  it("parses list defaults to all agents", () => {
    const parsed = parseManageArgs(["mcp", "list"])
    expect(parsed.action).toBe("list")
    expect(parsed.targetAgents).toEqual(["cursor", "claude", "gemini"])
  })

  it("parses add with command/arg/env", () => {
    const parsed = parseManageArgs([
      "mcp",
      "add",
      "figma",
      "--command",
      "npx",
      "--arg",
      "-y",
      "--arg",
      "server-figma",
      "--env",
      "FIGMA_TOKEN=test",
      "--cursor",
    ])
    expect(parsed.action).toBe("add")
    expect(parsed.name).toBe("figma")
    expect(parsed.command).toBe("npx")
    expect(parsed.args).toEqual(["-y", "server-figma"])
    expect(parsed.env).toEqual({ FIGMA_TOKEN: "test" })
    expect(parsed.targetAgents).toEqual(["cursor"])
  })
})

describe("manage mcp command", () => {
  it("adds and lists MCP servers for cursor", async () => {
    const home = await makeTempHome()
    const add = await runManage(
      [
        "mcp",
        "add",
        "figma",
        "--command",
        "npx",
        "--arg",
        "-y",
        "--arg",
        "@modelcontextprotocol/server-figma",
        "--env",
        "FIGMA_TOKEN=test-token",
        "--cursor",
      ],
      home
    )
    expect(add.exitCode).toBe(0)
    expect(add.stdout).toContain('Added "figma"')

    const configPath = join(home, ".cursor", "mcp.json")
    const jsonText = await readFile(configPath, "utf-8")
    const json = JSON.parse(jsonText) as {
      mcpServers?: Record<
        string,
        { command?: string; args?: string[]; env?: Record<string, string> }
      >
    }
    expect(json.mcpServers?.figma?.command).toBe("npx")
    expect(json.mcpServers?.figma?.args).toEqual(["-y", "@modelcontextprotocol/server-figma"])
    expect(json.mcpServers?.figma?.env).toEqual({ FIGMA_TOKEN: "test-token" })

    const list = await runManage(["mcp", "list", "--cursor"], home)
    expect(list.exitCode).toBe(0)
    expect(list.stdout).toContain("Cursor")
    expect(list.stdout).toContain("figma: npx")
  })

  it("removes MCP server entry", async () => {
    const home = await makeTempHome()
    const cursorDir = join(home, ".cursor")
    await mkdir(cursorDir, { recursive: true })
    await writeFile(
      join(cursorDir, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          figma: { command: "npx", args: ["-y", "@modelcontextprotocol/server-figma"] },
        },
      })
    )

    const remove = await runManage(["mcp", "remove", "figma", "--cursor"], home)
    expect(remove.exitCode).toBe(0)
    expect(remove.stdout).toContain('Removed "figma"')

    const jsonText = await readFile(join(cursorDir, "mcp.json"), "utf-8")
    const json = JSON.parse(jsonText) as { mcpServers?: Record<string, unknown> }
    expect(json.mcpServers).toEqual({})
  })

  it("validate reports malformed server definitions", async () => {
    const home = await makeTempHome()
    await writeFile(
      join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          bad: { args: ["-y"] },
        },
      })
    )

    const result = await runManage(["mcp", "validate", "--claude"], home)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("missing a non-empty command")
    expect(result.stderr).toContain("MCP validation failed")
  })

  it("validate succeeds with valid config", async () => {
    const home = await makeTempHome()
    await writeFile(
      join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          figma: { command: "/usr/bin/env", args: ["bash", "-lc", "echo ok"] },
        },
      })
    )

    const result = await runManage(["mcp", "validate", "--claude"], home)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("MCP validation passed")
  })
})
