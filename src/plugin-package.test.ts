import { describe, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { parse } from "yaml"
import { buildPluginHooks, PLUGIN_AGENTS } from "./plugin-package.ts"
import { useTempDir } from "./utils/test-utils.ts"

const repoRoot = resolve(import.meta.dir, "..")
const pluginRoot = join(repoRoot, "plugins/swiz-core")
const temp = useTempDir("swiz-plugin-package-")

async function json(path: string) {
  return Bun.file(join(pluginRoot, path)).json()
}

async function copyPackage(destination: string): Promise<void> {
  for await (const path of new Bun.Glob("**/*").scan({ cwd: pluginRoot, dot: true })) {
    await Bun.write(join(destination, path), Bun.file(join(pluginRoot, path)))
  }
}

async function executable(path: string, content: string): Promise<void> {
  await Bun.write(path, content)
  const proc = Bun.spawn(["/bin/chmod", "755", path], { stdout: "ignore", stderr: "inherit" })
  await proc.exited
  expect(proc.exitCode).toBe(0)
}

describe("dual host plugin package", () => {
  test("provider and portable manifests agree on identity and contained resources", async () => {
    const claude = await json(".claude-plugin/plugin.json")
    const codex = await json(".codex-plugin/plugin.json")
    const portable = await json("plugin.json")
    expect([claude.name, codex.name, portable.name]).toEqual(Array(3).fill("swiz-core"))
    expect(claude.version).toBe(portable.version)
    expect(codex.version).toBe(portable.version)
    expect(portable.$schema).toBe("https://agent-plugins.org/schemas/1.0.0/plugin.schema.json")
    expect(portable.extensions["com.openai"].hooks).toBe(codex.hooks)
    expect(claude.hooks).toBe("./hooks/claude.json")
    expect(codex.hooks).toBe("./hooks/codex.json")
    expect(await Bun.file(join(pluginRoot, "hooks/hooks.json")).exists()).toBe(false)
    for (const manifest of [claude, codex]) {
      for (const field of ["skills", "commands", "hooks", "mcpServers"]) {
        const path = manifest[field]
        if (!path) continue
        expect(path).toStartWith("./")
        expect(path.split("/")).not.toContain("..")
      }
      expect(await Bun.file(join(pluginRoot, manifest.hooks)).exists()).toBe(true)
    }
    const marketplace = await Bun.file(join(repoRoot, ".agents/plugins/marketplace.json")).json()
    expect(marketplace.name).toBe("swiz-marketplace")
    expect(resolve(repoRoot, marketplace.plugins[0].source.path)).toBe(pluginRoot)
    expect(marketplace.plugins[0].policy.installation).toBe("AVAILABLE")
    const claudeMarket = await Bun.file(join(repoRoot, ".claude-plugin/marketplace.json")).json()
    expect(claudeMarket.plugins[0].version).toBe(portable.version)
  })

  test.each([...PLUGIN_AGENTS])("%s hook artifact matches canonical routing", async (agent) => {
    expect(await json(`hooks/${agent}.json`)).toEqual(buildPluginHooks(agent))
    for (const groups of Object.values(buildPluginHooks(agent).hooks)) {
      expect(groups).toHaveLength(1)
      expect(groups[0]!.hooks).toHaveLength(1)
    }
  })

  test("all shared skills are discoverable without Claude-only interpolation", async () => {
    const names = new Set<string>()
    for await (const path of new Bun.Glob("skills/*/SKILL.md").scan(pluginRoot)) {
      const content = await Bun.file(join(pluginRoot, path)).text()
      const frontmatter = parse(content.split("---")[1]!)
      expect(frontmatter.name).toBe(basename(dirname(path)))
      expect(frontmatter.description.length).toBeGreaterThan(10)
      expect(content).not.toContain("$ARGUMENTS")
      expect(content).not.toContain("!`")
      expect(frontmatter["allowed-tools"]).toBeUndefined()
      expect(names.has(frontmatter.name)).toBe(false)
      names.add(frontmatter.name)
    }
    expect(names.size).toBe(17)
  })

  test.each([
    ...PLUGIN_AGENTS,
  ])("%s cached hooks preserve stdin, host identity and exit status", async (agent) => {
    const home = await temp.create()
    const cached = join(home, "plugin cache with spaces/swiz-core")
    await copyPackage(cached)
    const bin = join(home, "bin")
    await executable(
      join(bin, "swiz"),
      '#!/bin/sh\nprintf "%s\\n" "$*" "$SWIZ_PLUGIN" >&2\n/bin/cat\nexit 23\n'
    )
    const config = await Bun.file(join(cached, `hooks/${agent}.json`)).json()
    const command = config.hooks.PreToolUse[0].hooks[0].command
    const payload = JSON.stringify({
      session_id: "plugin-fixture",
      tool_name: "shell_command",
      cwd: home,
    })
    const proc = Bun.spawn(["/bin/sh", "-c", command], {
      cwd: cached,
      env: { ...process.env, HOME: home, PATH: bin, AI_TEST_NO_BACKEND: "1" },
      stdin: new TextEncoder().encode(payload),
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    await proc.exited
    expect(stdout).toBe(payload)
    expect(stderr).toBe(`dispatch --agent ${agent} preToolUse PreToolUse\n1\n`)
    expect(proc.exitCode).toBe(23)
  })

  test("missing CLI reports setup failure without corrupting hook stdout", async () => {
    const home = await temp.create()
    const command = buildPluginHooks("codex").hooks.SessionStart![0]!.hooks[0]!.command
    const proc = Bun.spawn(["/bin/sh", "-c", command], {
      cwd: home,
      env: { HOME: home, PATH: home },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    await proc.exited
    expect(proc.exitCode).toBe(1)
    expect(stdout).toBe("")
    expect(stderr).toContain("swiz is not on PATH")
  })

  test.each([
    "payload",
    "process",
  ])("plugin startup skips global repair with %s marker", async (source) => {
    const home = await temp.create()
    const payload = {
      session_id: "plugin-self-heal",
      cwd: home,
      source: "startup",
      ...(source === "payload" ? { _env: { SWIZ_PLUGIN: "1" } } : {}),
    }
    const proc = Bun.spawn([process.execPath, join(repoRoot, "hooks/sessionstart-self-heal.ts")], {
      cwd: home,
      env: {
        HOME: home,
        PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
        AI_TEST_NO_BACKEND: "1",
        SWIZ_NO_DAEMON: "1",
        ...(source === "process" ? { SWIZ_PLUGIN: "1" } : {}),
      },
      stdin: new TextEncoder().encode(JSON.stringify(payload)),
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    await proc.exited
    expect(proc.exitCode).toBe(0)
    expect(stdout).toBe("")
    expect(stderr).not.toContain("error:")
    expect(await Bun.file(join(home, ".claude/settings.json")).exists()).toBe(false)
    expect(await Bun.file(join(home, ".codex/hooks.json")).exists()).toBe(false)
    expect(await Bun.file(join(home, ".local/share/swiz/manifest-hash")).exists()).toBe(false)
  })

  test("portable and compatibility MCP configs launch real task tools from a cached package", async () => {
    const compatibility = await json(".mcp.json")
    const portable = await json("mcp.json")
    expect(portable.mcpServers.swiz).toEqual({ type: "stdio", ...compatibility.mcpServers.swiz })
    const home = await temp.create()
    const cached = join(home, "cache/swiz-core")
    await copyPackage(cached)
    const bin = join(home, "bin")
    await mkdir(bin, { recursive: true })
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
    // PROCESS_CONTRACT_TEST: the packaged mcp.json must launch a working swiz MCP server over
    // stdio, which only a real child process behind a `swiz` shim can prove.
    await executable(
      join(bin, "swiz"),
      `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(repoRoot, "index.ts"))} "$@"\n`
    )
    const config = await Bun.file(join(cached, "mcp.json")).json()
    const transport = new StdioClientTransport({
      command: config.mcpServers.swiz.command,
      args: config.mcpServers.swiz.args,
      cwd: home,
      env: {
        HOME: home,
        PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
        AI_TEST_NO_BACKEND: "1",
        SWIZ_NO_DAEMON: "1",
      },
      stderr: "pipe",
    })
    transport.stderr?.on("data", () => {})
    const client = new Client({ name: "swiz-plugin-test", version: "1.0.0" })
    try {
      await client.connect(transport)
      const tools = await client.listTools()
      expect(tools.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining(["TaskCreate", "TaskList", "TaskUpdate"])
      )
    } finally {
      await client.close()
    }
  }, 15_000)
})
