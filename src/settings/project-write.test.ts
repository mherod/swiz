import { describe, expect, spyOn, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { settingsCommand } from "../commands/settings.ts"
import { runCommandInProcess, useTempDir } from "../utils/test-utils.ts"
import { getProjectSettingsPath, writeProjectSettings } from "./persistence.ts"
import { SettingsStore } from "./store.ts"

const temp = useTempDir("project-write-")

async function fixture(content: string, backup = "previous recovery copy") {
  const cwd = await temp.create()
  const path = getProjectSettingsPath(cwd)
  await mkdir(dirname(path), { recursive: true })
  await Bun.write(path, content)
  await Bun.write(`${path}.bak`, backup)
  return { cwd, path, content, backup }
}

describe("project settings write preservation", () => {
  test.each([
    '{"pushGate":false,',
    "null",
    "[]",
    '"text"',
    "42",
    "true",
  ])("rejects invalid existing object: %s", async (content) => {
    const f = await fixture(content)
    await expect(writeProjectSettings(f.cwd, { collaborationMode: "solo" })).rejects.toThrow(f.path)
    expect(await Bun.file(f.path).text()).toBe(content)
    expect(await Bun.file(`${f.path}.bak`).text()).toBe(f.backup)
  })

  test("does not treat a read failure as a missing file", async () => {
    const f = await fixture('{"pushGate":false}')
    const originalFile = Bun.file.bind(Bun)
    const spy = spyOn(Bun, "file").mockImplementation((...args) => {
      const [path, options] = args
      const file =
        typeof path === "number"
          ? originalFile(path, options)
          : typeof path === "string" || path instanceof URL
            ? originalFile(path, options)
            : originalFile(path, options)
      if (args[0] === f.path) {
        file.text = async () => {
          throw Object.assign(new Error("permission denied"), { code: "EACCES" })
        }
      }
      return file
    })
    try {
      await expect(writeProjectSettings(f.cwd, { pushGate: true })).rejects.toThrow(f.path)
    } finally {
      spy.mockRestore()
    }
    expect(await Bun.file(f.path).text()).toBe(f.content)
    expect(await Bun.file(`${f.path}.bak`).text()).toBe(f.backup)
  })

  test("creates missing config and preserves unknown fields with an exact backup", async () => {
    const cwd = await temp.create()
    const path = await writeProjectSettings(cwd, { pushGate: false })
    expect(await Bun.file(path).json()).toEqual({ pushGate: false })
    expect(await Bun.file(`${path}.bak`).exists()).toBe(false)
    const f = await fixture('{ "custom": { "nested": 7 }, "pushGate": false }\n')
    await writeProjectSettings(f.cwd, { collaborationMode: "solo" })
    expect(await Bun.file(f.path).json()).toEqual({
      custom: { nested: 7 },
      pushGate: false,
      collaborationMode: "solo",
    })
    expect(await Bun.file(`${f.path}.bak`).text()).toBe(f.content)
  })

  test("store hook updates preserve invalid configuration", async () => {
    const f = await fixture("{")
    const store = new SettingsStore({ home: f.cwd })
    await expect(store.disableHook("project", "example.ts", f.cwd)).rejects.toThrow(f.path)
    await expect(store.setProject(f.cwd, "pushGate", true)).rejects.toThrow(f.path)
    expect(await Bun.file(f.path).text()).toBe(f.content)
    expect(await Bun.file(`${f.path}.bak`).text()).toBe(f.backup)
  })

  test("CLI reports repair guidance without changing config or backup", async () => {
    const f = await fixture("{")
    const result = await runCommandInProcess(
      settingsCommand,
      ["set", "collab-mode", "solo", "--project", "--json"],
      { cwd: f.cwd, env: { HOME: f.cwd } }
    )
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain(f.path)
    expect(result.stderr).toContain("Repair")
    expect(await Bun.file(f.path).text()).toBe(f.content)
    expect(await Bun.file(`${f.path}.bak`).text()).toBe(f.backup)
    expect(await Bun.file(join(f.cwd, ".swiz", "settings.json")).exists()).toBe(false)
  })
})
