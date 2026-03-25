import { describe, expect, test } from "bun:test"
import { mkdir, stat } from "node:fs/promises"
import { join } from "node:path"
import { useTempDir } from "../../hooks/utils/test-utils.ts"
import { pluginsCommand } from "./plugins.ts"

const { create: createTempDir } = useTempDir("swiz-plugins-")

interface ConsoleCapture {
  messages: string[]
  restore: () => void
}

function captureConsoleLog(): ConsoleCapture {
  const messages: string[] = []
  const original = console.log
  console.log = (...args: unknown[]) => {
    messages.push(args.map((arg) => String(arg)).join(" "))
  }
  return {
    messages,
    restore: () => {
      console.log = original
    },
  }
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
    const pluginsDir = join(home, ".claude", "plugins")
    await writeInstalledPlugins(home, {
      version: 1,
      plugins: {
        "alpha@claude-plugins-official": [
          { installPath: join(home, ".claude/plugins/cache/alpha") },
        ],
        "beta@custom": [{ installPath: join(home, ".claude/plugins/cache/beta") }],
      },
    })

    const captured = captureConsoleLog()
    await pluginsCommand.run(["list", "--json", "--plugins-dir", pluginsDir])
    captured.restore()

    const payload = JSON.parse(captured.messages.join("\n")) as Array<{ key: string }>
    expect(payload.map((p) => p.key)).toEqual(["alpha@claude-plugins-official", "beta@custom"])
  })

  test("info errors on ambiguous plugin name", async () => {
    const home = await createTempDir()
    const pluginsDir = join(home, ".claude", "plugins")
    await writeInstalledPlugins(home, {
      version: 1,
      plugins: {
        "alpha@one": [{ installPath: join(home, ".claude/plugins/cache/alpha-one") }],
        "alpha@two": [{ installPath: join(home, ".claude/plugins/cache/alpha-two") }],
      },
    })

    await expect(
      pluginsCommand.run(["info", "alpha", "--plugins-dir", pluginsDir])
    ).rejects.toThrow("ambiguous")
  })

  test("uninstall removes install directory and registry entry", async () => {
    const home = await createTempDir()
    const pluginsDir = join(home, ".claude", "plugins")
    const installPath = join(home, ".claude/plugins/cache/alpha")
    const dataPath = join(home, ".claude/plugins/data/alpha-claude-plugins-official")
    await mkdir(installPath, { recursive: true })
    await Bun.write(join(installPath, "file.txt"), "x")
    await mkdir(dataPath, { recursive: true })
    await Bun.write(join(dataPath, "data.json"), "{}")
    await writeInstalledPlugins(home, {
      version: 1,
      plugins: {
        "alpha@claude-plugins-official": [{ installPath }],
        "beta@custom": [{ installPath: join(home, ".claude/plugins/cache/beta") }],
      },
    })

    const captured = captureConsoleLog()
    await pluginsCommand.run([
      "uninstall",
      "alpha@claude-plugins-official",
      "--plugins-dir",
      pluginsDir,
    ])
    captured.restore()
    expect(captured.messages.join("\n")).toContain("Uninstalled Claude plugin")

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
    await expect(stat(dataPath)).rejects.toBeDefined()
  })
})
