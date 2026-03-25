import { describe, expect, test } from "bun:test"
import { mkdir, stat } from "node:fs/promises"
import { join } from "node:path"
import { useTempDir } from "../../hooks/utils/test-utils.ts"

interface RunResult {
  exitCode: number | null
  stdout: string
  stderr: string
}

const { create: createTempDir } = useTempDir("swiz-plugins-")

async function runCli(args: string[], homeDir: string): Promise<RunResult> {
  const proc = Bun.spawn([process.execPath, "run", "index.ts", ...args], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HOME: homeDir, SWIZ_DIRECT: "1" },
  })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited
  return { exitCode: proc.exitCode, stdout, stderr }
}

async function writeInstalledPlugins(homeDir: string, payload: unknown): Promise<void> {
  const pluginsDir = join(homeDir, ".claude", "plugins")
  await mkdir(pluginsDir, { recursive: true })
  await Bun.write(
    join(pluginsDir, "installed_plugins.json"),
    `${JSON.stringify(payload, null, 2)}\n`
  )
}

describe("swiz plugins", () => {
  test("list --json returns installed plugins", async () => {
    const home = await createTempDir()
    await writeInstalledPlugins(home, {
      version: 1,
      plugins: {
        "alpha@claude-plugins-official": [
          { installPath: join(home, ".claude/plugins/cache/alpha") },
        ],
        "beta@custom": [{ installPath: join(home, ".claude/plugins/cache/beta") }],
      },
    })

    const result = await runCli(["plugins", "list", "--json"], home)
    expect(result.exitCode).toBe(0)
    const payload = JSON.parse(result.stdout) as Array<{ key: string }>
    expect(payload.map((p) => p.key)).toEqual(["alpha@claude-plugins-official", "beta@custom"])
  })

  test("info errors on ambiguous plugin name", async () => {
    const home = await createTempDir()
    await writeInstalledPlugins(home, {
      version: 1,
      plugins: {
        "alpha@one": [{ installPath: join(home, ".claude/plugins/cache/alpha-one") }],
        "alpha@two": [{ installPath: join(home, ".claude/plugins/cache/alpha-two") }],
      },
    })

    const result = await runCli(["plugins", "info", "alpha"], home)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("ambiguous")
  })

  test("uninstall removes install directory and registry entry", async () => {
    const home = await createTempDir()
    const installPath = join(home, ".claude/plugins/cache/alpha")
    await mkdir(installPath, { recursive: true })
    await Bun.write(join(installPath, "file.txt"), "x")
    await writeInstalledPlugins(home, {
      version: 1,
      plugins: {
        "alpha@claude-plugins-official": [{ installPath }],
        "beta@custom": [{ installPath: join(home, ".claude/plugins/cache/beta") }],
      },
    })

    const result = await runCli(["plugins", "uninstall", "alpha@claude-plugins-official"], home)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("Uninstalled Claude plugin")

    const installedPath = join(home, ".claude", "plugins", "installed_plugins.json")
    const payload = (await Bun.file(installedPath).json()) as {
      plugins: Record<string, unknown>
    }
    expect(payload.plugins["alpha@claude-plugins-official"]).toBeUndefined()
    expect(payload.plugins["beta@custom"]).toBeDefined()

    await expect(
      stat(join(home, ".claude", "plugins", "installed_plugins.json.bak"))
    ).resolves.toBeDefined()
    await expect(stat(installPath)).rejects.toBeDefined()
  })
})
