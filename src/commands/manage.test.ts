import { describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseManageArgs } from "./manage.ts"

const DESKTOP_CONFIG_SUBPATH = join(
  "Library",
  "Application Support",
  "Claude",
  "claude_desktop_config.json"
)

const INDEX_PATH = join(import.meta.dir, "..", "..", "index.ts")

async function makeTempHome(prefix = "swiz-manage-test-"): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix))
}

async function runManage(
  args: string[],
  home: string,
  cwd?: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", INDEX_PATH, "manage", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    cwd: cwd ?? home,
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
  it("parses list defaults to all agents including claude-desktop", () => {
    const parsed = parseManageArgs(["mcp", "list"])
    expect(parsed.action).toBe("list")
    expect(parsed.targetAgents).toEqual(["cursor", "claude", "claude-desktop", "gemini", "junie"])
  })

  it("parses --claude-desktop flag", () => {
    const parsed = parseManageArgs(["mcp", "list", "--claude-desktop"])
    expect(parsed.targetAgents).toEqual(["claude-desktop"])
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
    const json = JSON.parse(jsonText) as { mcpServers?: Record<string, any> }
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

describe("manage mcp --project (cursor: .cursor/mcp.json)", () => {
  it("adds and lists MCP servers in project .cursor/mcp.json", async () => {
    const home = await makeTempHome()
    const projectDir = await mkdtemp(join(tmpdir(), "swiz-project-cursor-"))
    const add = await runManage(
      [
        "mcp",
        "add",
        "my-server",
        "--command",
        "npx",
        "--arg",
        "server-pkg",
        "--cursor",
        "--project",
      ],
      home,
      projectDir
    )
    expect(add.exitCode).toBe(0)
    expect(add.stdout).toContain('Added "my-server"')

    const configPath = join(projectDir, ".cursor", "mcp.json")
    const jsonText = await readFile(configPath, "utf-8")
    const json = JSON.parse(jsonText) as {
      mcpServers?: Record<string, { command?: string; args?: string[] }>
    }
    expect(json.mcpServers?.["my-server"]?.command).toBe("npx")
    expect(json.mcpServers?.["my-server"]?.args).toEqual(["server-pkg"])

    const list = await runManage(["mcp", "list", "--cursor", "--project"], home, projectDir)
    expect(list.exitCode).toBe(0)
    expect(list.stdout).toContain("Cursor (project)")
    expect(list.stdout).toContain("my-server: npx")
  })

  it("removes MCP server from project .cursor/mcp.json", async () => {
    const home = await makeTempHome()
    const projectDir = await mkdtemp(join(tmpdir(), "swiz-project-cursor-rm-"))
    const cursorDir = join(projectDir, ".cursor")
    await mkdir(cursorDir, { recursive: true })
    await writeFile(
      join(cursorDir, "mcp.json"),
      JSON.stringify({ mcpServers: { figma: { command: "npx" } } })
    )

    const remove = await runManage(
      ["mcp", "remove", "figma", "--cursor", "--project"],
      home,
      projectDir
    )
    expect(remove.exitCode).toBe(0)
    expect(remove.stdout).toContain('Removed "figma"')

    const jsonText = await readFile(join(cursorDir, "mcp.json"), "utf-8")
    const json = JSON.parse(jsonText) as { mcpServers?: Record<string, any> }
    expect(json.mcpServers).toEqual({})
  })

  it("validate reports malformed server in project .cursor/mcp.json", async () => {
    const home = await makeTempHome()
    const projectDir = await mkdtemp(join(tmpdir(), "swiz-project-cursor-val-"))
    const cursorDir = join(projectDir, ".cursor")
    await mkdir(cursorDir, { recursive: true })
    await writeFile(
      join(cursorDir, "mcp.json"),
      JSON.stringify({ mcpServers: { bad: { args: ["-y"] } } })
    )

    const result = await runManage(["mcp", "validate", "--cursor", "--project"], home, projectDir)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("missing a non-empty command")
  })
})

describe("manage mcp --project (claude: .mcp.json)", () => {
  it("adds and lists MCP servers in project .mcp.json", async () => {
    const home = await makeTempHome()
    const projectDir = await mkdtemp(join(tmpdir(), "swiz-project-mcp-"))
    const add = await runManage(
      [
        "mcp",
        "add",
        "context7",
        "--command",
        "npx",
        "--arg",
        "context7-server",
        "--claude",
        "--project",
      ],
      home,
      projectDir
    )
    expect(add.exitCode).toBe(0)
    expect(add.stdout).toContain('Added "context7"')

    const jsonText = await readFile(join(projectDir, ".mcp.json"), "utf-8")
    const json = JSON.parse(jsonText) as { mcpServers?: Record<string, { command?: string }> }
    expect(json.mcpServers?.context7?.command).toBe("npx")

    const list = await runManage(["mcp", "list", "--claude", "--project"], home, projectDir)
    expect(list.exitCode).toBe(0)
    expect(list.stdout).toContain("Claude Code (project)")
    expect(list.stdout).toContain("context7: npx")
  })

  it("removes MCP server from project .mcp.json", async () => {
    const home = await makeTempHome()
    const projectDir = await mkdtemp(join(tmpdir(), "swiz-project-mcp-rm-"))
    await writeFile(
      join(projectDir, ".mcp.json"),
      JSON.stringify({ mcpServers: { context7: { command: "npx" } } })
    )

    const remove = await runManage(
      ["mcp", "remove", "context7", "--claude", "--project"],
      home,
      projectDir
    )
    expect(remove.exitCode).toBe(0)
    expect(remove.stdout).toContain('Removed "context7"')

    const jsonText = await readFile(join(projectDir, ".mcp.json"), "utf-8")
    const json = JSON.parse(jsonText) as { mcpServers?: Record<string, any> }
    expect(json.mcpServers).toEqual({})
  })
})

describe("manage mcp --project (gemini/vscode: .vscode/mcp.json)", () => {
  it("adds and lists MCP servers in project .vscode/mcp.json", async () => {
    const home = await makeTempHome()
    const projectDir = await mkdtemp(join(tmpdir(), "swiz-project-vscode-"))
    const add = await runManage(
      ["mcp", "add", "vscode-server", "--command", "node", "--gemini", "--project"],
      home,
      projectDir
    )
    expect(add.exitCode).toBe(0)
    expect(add.stdout).toContain('Added "vscode-server"')

    const jsonText = await readFile(join(projectDir, ".vscode", "mcp.json"), "utf-8")
    const json = JSON.parse(jsonText) as { mcpServers?: Record<string, { command?: string }> }
    expect(json.mcpServers?.["vscode-server"]?.command).toBe("node")

    const list = await runManage(["mcp", "list", "--gemini", "--project"], home, projectDir)
    expect(list.exitCode).toBe(0)
    expect(list.stdout).toContain("VS Code / Gemini (project)")
    expect(list.stdout).toContain("vscode-server: node")
  })

  it("validate succeeds for valid project .vscode/mcp.json", async () => {
    const home = await makeTempHome()
    const projectDir = await mkdtemp(join(tmpdir(), "swiz-project-vscode-val-"))
    const vscodeDir = join(projectDir, ".vscode")
    await mkdir(vscodeDir, { recursive: true })
    await writeFile(
      join(vscodeDir, "mcp.json"),
      JSON.stringify({
        mcpServers: { myserver: { command: "/usr/bin/env", args: ["echo", "ok"] } },
      })
    )

    const result = await runManage(["mcp", "validate", "--gemini", "--project"], home, projectDir)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("MCP validation passed")
  })
})

describe("manage mcp --project (global behavior unchanged)", () => {
  it("global list still uses HOME-backed paths when no --project flag", async () => {
    const home = await makeTempHome()
    const projectDir = await mkdtemp(join(tmpdir(), "swiz-project-global-check-"))
    const cursorDir = join(home, ".cursor")
    await mkdir(cursorDir, { recursive: true })
    await writeFile(
      join(cursorDir, "mcp.json"),
      JSON.stringify({ mcpServers: { global_server: { command: "npx" } } })
    )

    const list = await runManage(["mcp", "list", "--cursor"], home, projectDir)
    expect(list.exitCode).toBe(0)
    expect(list.stdout).toContain("global_server: npx")
    // Path shown should be in home, not projectDir
    expect(list.stdout).toContain(home)
  })
})

describe("manage mcp --claude-desktop (global Claude Desktop config)", () => {
  it("resolves path to Library/Application Support/Claude/claude_desktop_config.json", async () => {
    const home = await makeTempHome()
    const list = await runManage(["mcp", "list", "--claude-desktop"], home)
    expect(list.exitCode).toBe(0)
    expect(list.stdout).toContain("Claude Desktop")
    expect(list.stdout).toContain(join(home, DESKTOP_CONFIG_SUBPATH))
  })

  it("adds and lists MCP servers in Claude Desktop config", async () => {
    const home = await makeTempHome()
    const add = await runManage(
      ["mcp", "add", "magic-ui", "--command", "npx", "--claude-desktop"],
      home
    )
    expect(add.exitCode).toBe(0)
    expect(add.stdout).toContain('Added "magic-ui"')
    expect(add.stdout).toContain("Claude Desktop")

    const configPath = join(home, DESKTOP_CONFIG_SUBPATH)
    const jsonText = await readFile(configPath, "utf-8")
    const json = JSON.parse(jsonText) as { mcpServers?: Record<string, { command?: string }> }
    expect(json.mcpServers?.["magic-ui"]?.command).toBe("npx")

    const list = await runManage(["mcp", "list", "--claude-desktop"], home)
    expect(list.exitCode).toBe(0)
    expect(list.stdout).toContain("Claude Desktop")
    expect(list.stdout).toContain("magic-ui: npx")
  })

  it("removes MCP server from Claude Desktop config", async () => {
    const home = await makeTempHome()
    const desktopDir = join(home, "Library", "Application Support", "Claude")
    await mkdir(desktopDir, { recursive: true })
    await writeFile(
      join(desktopDir, "claude_desktop_config.json"),
      JSON.stringify({ mcpServers: { "magic-ui": { command: "npx" } } })
    )

    const remove = await runManage(["mcp", "remove", "magic-ui", "--claude-desktop"], home)
    expect(remove.exitCode).toBe(0)
    expect(remove.stdout).toContain('Removed "magic-ui"')

    const jsonText = await readFile(join(desktopDir, "claude_desktop_config.json"), "utf-8")
    const json = JSON.parse(jsonText) as { mcpServers?: Record<string, any> }
    expect(json.mcpServers).toEqual({})
  })

  it("validate reports malformed server in Claude Desktop config", async () => {
    const home = await makeTempHome()
    const desktopDir = join(home, "Library", "Application Support", "Claude")
    await mkdir(desktopDir, { recursive: true })
    await writeFile(
      join(desktopDir, "claude_desktop_config.json"),
      JSON.stringify({ mcpServers: { bad: { args: ["-y"] } } })
    )

    const result = await runManage(["mcp", "validate", "--claude-desktop"], home)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("missing a non-empty command")
  })

  it("validate succeeds with valid Claude Desktop config", async () => {
    const home = await makeTempHome()
    const desktopDir = join(home, "Library", "Application Support", "Claude")
    await mkdir(desktopDir, { recursive: true })
    await writeFile(
      join(desktopDir, "claude_desktop_config.json"),
      JSON.stringify({
        mcpServers: { "my-server": { command: "/usr/bin/env", args: ["echo", "ok"] } },
      })
    )

    const result = await runManage(["mcp", "validate", "--claude-desktop"], home)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("MCP validation passed")
  })

  it("existing Claude Code --claude behavior unchanged", async () => {
    const home = await makeTempHome()
    await writeFile(
      join(home, ".claude.json"),
      JSON.stringify({ mcpServers: { "code-server": { command: "node" } } })
    )

    const list = await runManage(["mcp", "list", "--claude"], home)
    expect(list.exitCode).toBe(0)
    expect(list.stdout).toContain("Claude Code")
    expect(list.stdout).toContain(join(home, ".claude.json"))
    expect(list.stdout).toContain("code-server: node")
  })
})
