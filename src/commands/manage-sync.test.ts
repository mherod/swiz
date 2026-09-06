import { describe, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { runCommandInProcess, useTempDir } from "../utils/test-utils.ts"
import { installCommand } from "./install.ts"
import {
  installSwizAsMcpServer,
  manageCommand,
  mcpServersEqual,
  parseManageArgs,
  translateServerForAgent,
  uninstallSwizAsMcpServer,
} from "./manage.ts"
import { readMcpFile, writeMcpFile } from "./mcp-config.ts"

const { create } = useTempDir("swiz-mcp-sync-")
async function write(path: string, value: string | object): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await Bun.write(path, typeof value === "string" ? value : JSON.stringify(value))
}
async function run(args: string[], home: string, cwd = home, installed: string[] = []) {
  return runCommandInProcess(manageCommand, ["mcp", ...args], {
    commandOptions: {
      home,
      cwd,
      which: () => "/mock/bin/bun",
      detectAgents: async () => installed,
    },
    env: { HOME: home },
  })
}
const command = { command: "bun", args: ["x", "server with spaces"], env: { TOKEN: "dummy=value" } }

describe("Antigravity MCP", () => {
  test("install command includes Antigravity MCP in its scoped preview", async () => {
    const home = await create()
    const result = await runCommandInProcess(installCommand, ["--antigravity", "--dry-run"], {
      commandOptions: { homeDir: home, bunAvailable: () => true },
      env: { HOME: home },
      cwd: home,
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain(join(home, ".gemini", "config", "mcp_config.json"))
    expect(await Bun.file(join(home, ".gemini", "config", "mcp_config.json")).exists()).toBe(false)
  })
  test("validates native remote serverUrl without treating it as a missing binary", async () => {
    const home = await create()
    await write(join(home, ".gemini", "config", "mcp_config.json"), {
      mcpServers: {
        remote: { serverUrl: "https://example.invalid/mcp", headers: { Authorization: "test" } },
      },
    })
    expect((await run(["validate", "--agy"], home)).exitCode).toBe(0)
    expect((await run(["list", "--agy"], home)).stdout).toContain("https://example.invalid/mcp")
  })
  test.each([
    false,
    true,
  ])("CRUD and aliases use the correct scoped path: project=%s", async (project) => {
    const home = await create()
    const cwd = join(home, "workspace")
    const path = project
      ? join(cwd, ".agents", "mcp_config.json")
      : join(home, ".gemini", "config", "mcp_config.json")
    const scope = project ? ["--project"] : []
    const hooks = join(home, ".gemini", "antigravity-cli", "hooks.json")
    await write(hooks, { custom: true })
    await write(path, { keep: true, mcpServers: {} })
    expect(
      (await run(["add", "demo", "--command", "bun", "--agy", ...scope], home, cwd)).exitCode
    ).toBe(0)
    expect((await Bun.file(path).json()).mcpServers.demo).toEqual({ command: "bun" })
    expect((await Bun.file(`${path}.bak`).json()).keep).toBe(true)
    for (const action of ["list", "show", "validate"]) {
      const result = await run(
        [action, ...(action === "show" ? ["demo"] : []), "--antigravity", ...scope],
        home,
        cwd
      )
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain(action === "validate" ? "passed" : "demo")
    }
    expect((await run(["remove", "demo", "--agy", ...scope], home, cwd)).exitCode).toBe(0)
    expect(await Bun.file(path).json()).toEqual({ keep: true, mcpServers: {} })
    expect(await Bun.file(hooks).json()).toEqual({ custom: true })
  })

  test("installation is reversible and dry-run leaves no files", async () => {
    const home = await create()
    const path = join(home, ".gemini", "config", "mcp_config.json")
    expect(
      (await installSwizAsMcpServer(["antigravity", "codex"], home, false, true)).updated
    ).toHaveLength(2)
    expect(await Bun.file(path).exists()).toBe(false)
    await installSwizAsMcpServer(["antigravity", "codex"], home, false, false)
    expect((await Bun.file(path).json()).mcpServers.swiz).toEqual({
      command: "swiz",
      args: ["mcp"],
    })
    expect(
      (await installSwizAsMcpServer(["antigravity", "codex"], home, false, false)).skipped
    ).toHaveLength(2)
    await uninstallSwizAsMcpServer(["antigravity", "codex"], home, false, false)
    expect((await Bun.file(path).json()).mcpServers).toEqual({})
    expect(
      (
        Bun.TOML.parse(await Bun.file(join(home, ".codex", "config.toml")).text()) as Record<
          string,
          unknown
        >
      ).mcp_servers
    ).toBeUndefined()
  })
})

describe("cross-agent synchronization", () => {
  test.each([
    false,
    true,
  ])("unions configured and detected targets, preserves unrelated settings and converges: project=%s", async (project) => {
    const home = await create()
    const cwd = project ? join(home, "workspace") : home
    const agy = project
      ? join(cwd, ".agents", "mcp_config.json")
      : join(home, ".gemini", "config", "mcp_config.json")
    const codex = join(cwd, ".codex", "config.toml")
    const claude = join(cwd, project ? ".mcp.json" : ".claude.json")
    const cursor = join(cwd, ".cursor", "mcp.json")
    await write(agy, { custom: true, mcpServers: { demo: command } })
    const original =
      '# keep this comment\nmodel = "test-model"\n\n[features]\ncustom = true\n\n[mcp_servers.other]\ncommand = "other"\n'
    await write(codex, original)
    await write(claude, { mcpServers: { third: { command: "third" } } })
    const args = ["sync", ...(project ? ["--project"] : [])]
    expect((await run([...args, "--dry-run"], home, cwd, ["cursor"])).exitCode).toBe(0)
    expect(await Bun.file(codex).text()).toBe(original)
    expect(await Bun.file(cursor).exists()).toBe(false)
    expect((await run(args, home, cwd, ["cursor"])).exitCode).toBe(0)
    const expected = { demo: command, other: { command: "other" }, third: { command: "third" } }
    for (const path of [agy, codex, claude, cursor])
      expect((await readMcpFile(path)).mcpServers).toEqual(expected)
    const result = await Bun.file(codex).text()
    expect(result).toContain("# keep this comment")
    expect((Bun.TOML.parse(result) as Record<string, unknown>).features).toEqual({ custom: true })
    expect(await Bun.file(`${codex}.bak`).text()).toBe(original)
    expect((await run(args, home, cwd, ["cursor"])).exitCode).toBe(0)
    expect(await Bun.file(codex).text()).toBe(result)
    expect(await Bun.file(`${codex}.bak`).text()).toBe(original)
    expect(await Bun.file(join(home, ".ai", "mcp", "mcp.json")).exists()).toBe(false)
  })

  test.each([
    "conflict",
    "malformed",
    "unsupported",
  ])("preflights %s without any writes or secret output", async (kind) => {
    const home = await create()
    const agy = join(home, ".gemini", "config", "mcp_config.json")
    const codex = join(home, ".codex", "config.toml")
    const input =
      kind === "malformed"
        ? '{secret="private-value"'
        : JSON.stringify({
            mcpServers: {
              demo:
                kind === "unsupported" ? { url: "https://example.invalid/private-value" } : command,
            },
          })
    await write(agy, input)
    await write(codex, '[mcp_servers.demo]\ncommand = "different"\n')
    const before = await Bun.file(codex).text()
    const result = await run(["sync", "--agy", "--codex"], home)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).not.toContain("private-value")
    expect(await Bun.file(agy).text()).toBe(input)
    expect(await Bun.file(codex).text()).toBe(before)
    expect(await Bun.file(`${codex}.bak`).exists()).toBe(false)
  })

  test("directed merge selects a winner and handles quoted server names", async () => {
    const home = await create()
    const path = join(home, ".gemini", "config", "mcp_config.json")
    await write(path, { mcpServers: { 'quoted."name': command, __proto__: undefined } })
    expect((await run(["merge", "--from", "agy", "--codex"], home)).exitCode).toBe(0)
    expect(
      (await readMcpFile(join(home, ".codex", "config.toml"))).mcpServers?.['quoted."name']
    ).toEqual(command)
    expect((await run(["merge", "--from", "codex", "--claude"], home)).exitCode).toBe(0)
    expect((await Bun.file(join(home, ".claude.json")).json()).mcpServers['quoted."name']).toEqual(
      command
    )
  })

  test("stale reads cannot overwrite a later settings edit", async () => {
    const home = await create()
    const path = join(home, "config.toml")
    await write(path, 'model = "one"\n')
    const data = await readMcpFile(path)
    await write(path, 'model = "two"\n')
    await expect(writeMcpFile(path, { ...data, mcpServers: { demo: command } })).rejects.toThrow(
      "changed during operation"
    )
    expect(await Bun.file(path).text()).toBe('model = "two"\n')
  })

  test("Codex CRUD preserves multiline strings, inline maps and unrelated tables", async () => {
    const home = await create()
    const path = join(home, ".codex", "config.toml")
    const text =
      'model_instructions = """\n[mcp_servers.fake]\nnot a table\n"""\nmcp_servers.old = { command = "old", enabled = false }\n[features]\nexperimental = true\n'
    await write(path, text)
    expect((await run(["add", "new", "--command", "bun", "--codex"], home)).exitCode).toBe(0)
    expect((await run(["validate", "--codex"], home)).exitCode).toBe(0)
    expect((await run(["remove", "old", "--codex"], home)).exitCode).toBe(0)
    const actual = Bun.TOML.parse(await Bun.file(path).text()) as Record<string, unknown>
    expect(actual.model_instructions).toBe("\n[mcp_servers.fake]\nnot a table\n")
    expect(actual.features).toEqual({ experimental: true })
    expect(actual.mcp_servers).toEqual({ new: { command: "bun" } })
  })

  test("help and alias parsing expose the new targets and preview", () => {
    expect(parseManageArgs(["mcp", "sync", "--agy", "--codex", "--dry-run"]).targetAgents).toEqual([
      "antigravity",
      "codex",
    ])
    expect(manageCommand.usage).toContain("sync")
    expect(manageCommand.options?.some((option) => option.flags.includes("--agy"))).toBe(true)
    expect(() => parseManageArgs(["mcp", "sync", "--from", "all"])).toThrow("merge")
  })
})

describe("remote server translation", () => {
  test("merging remote URL server from Cursor to Antigravity produces serverUrl in mcp_config.json", async () => {
    const home = await create()
    const cursor = join(home, ".cursor", "mcp.json")
    const agy = join(home, ".gemini", "config", "mcp_config.json")
    await write(cursor, {
      mcpServers: {
        remote: {
          url: "https://example.com/mcp",
          headers: { Authorization: "Bearer test-token" },
        },
      },
    })
    const result = await run(["merge", "--from", "cursor", "--agy"], home)
    expect(result.exitCode).toBe(0)
    const agyConfig = await Bun.file(agy).json()
    expect(agyConfig.mcpServers.remote).toEqual({
      serverUrl: "https://example.com/mcp",
      headers: { Authorization: "Bearer test-token" },
    })
  })

  test("merging remote URL server from Antigravity to Cursor produces url in mcp.json", async () => {
    const home = await create()
    const cursor = join(home, ".cursor", "mcp.json")
    const agy = join(home, ".gemini", "config", "mcp_config.json")
    await write(agy, {
      mcpServers: {
        remote: {
          serverUrl: "https://example.com/mcp",
          headers: { Authorization: "Bearer test-token" },
        },
      },
    })
    const result = await run(["merge", "--from", "agy", "--cursor"], home)
    expect(result.exitCode).toBe(0)
    const cursorConfig = await Bun.file(cursor).json()
    expect(cursorConfig.mcpServers.remote).toEqual({
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer test-token" },
    })
  })

  test("invalid URL formats are caught during validation before writes", async () => {
    const home = await create()
    const cursor = join(home, ".cursor", "mcp.json")
    const agy = join(home, ".gemini", "config", "mcp_config.json")
    await write(cursor, {
      mcpServers: {
        bad: { url: "not-a-valid-url" },
      },
    })
    const result = await run(["merge", "--from", "cursor", "--agy"], home)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('Server "bad" has an invalid url')
    expect(await Bun.file(agy).exists()).toBe(false)
  })

  test("syncing between Cursor and Antigravity converges and translates url and serverUrl", async () => {
    const home = await create()
    const cursor = join(home, ".cursor", "mcp.json")
    const agy = join(home, ".gemini", "config", "mcp_config.json")
    await write(cursor, {
      mcpServers: {
        fromCursor: { url: "https://example.com/cursor" },
      },
    })
    await write(agy, {
      mcpServers: {
        fromAgy: { serverUrl: "https://example.com/agy" },
      },
    })
    const result = await run(["sync", "--cursor", "--agy"], home)
    expect(result.exitCode).toBe(0)
    const cursorConfig = await Bun.file(cursor).json()
    const agyConfig = await Bun.file(agy).json()
    expect(cursorConfig.mcpServers).toEqual({
      fromCursor: { url: "https://example.com/cursor" },
      fromAgy: { url: "https://example.com/agy" },
    })
    expect(agyConfig.mcpServers).toEqual({
      fromCursor: { serverUrl: "https://example.com/cursor" },
      fromAgy: { serverUrl: "https://example.com/agy" },
    })
  })

  test("translateServerForAgent maps url and serverUrl correctly", () => {
    const cursorServer = { url: "https://example.com/mcp", headers: { token: "secret" } }
    const agyServer = { serverUrl: "https://example.com/mcp", headers: { token: "secret" } }
    const stdioServer = { command: "bun", args: ["run"] }

    expect(translateServerForAgent(cursorServer, "antigravity")).toEqual(agyServer)
    expect(translateServerForAgent(agyServer, "cursor")).toEqual(cursorServer)
    expect(translateServerForAgent(cursorServer, "cursor")).toEqual(cursorServer)
    expect(translateServerForAgent(stdioServer, "antigravity")).toEqual(stdioServer)
  })

  test("mcpServersEqual equates equivalent url and serverUrl definitions", () => {
    const cursorServer = { url: "https://example.com/mcp", headers: { token: "secret" } }
    const agyServer = { serverUrl: "https://example.com/mcp", headers: { token: "secret" } }
    const differentServer = { url: "https://other.com/mcp", headers: { token: "secret" } }

    expect(mcpServersEqual(cursorServer, agyServer)).toBe(true)
    expect(mcpServersEqual(cursorServer, differentServer)).toBe(false)
  })
})
