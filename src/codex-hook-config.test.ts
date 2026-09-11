import { describe, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import {
  inspectCodexHookSources,
  planCodexHookRepair,
  repairCodexHookSources,
} from "./codex-hook-config.ts"
import { useTempDir } from "./utils/test-utils.ts"

const temp = useTempDir("codex-hook-config-")
const existingHooks = {
  version: 1,
  hooks: { SessionStart: [{ hooks: [{ type: "command", command: "existing", timeout: 20 }] }] },
}
const inline =
  '[[hooks.SessionStart]]\nmatcher = "startup|resume"\n[[hooks.SessionStart.hooks]]\ntype = "command"\ncommand = "custom index"\nstatusMessage = "Indexing"\ntimeout = 2\n'

async function fixture(toml = inline, json = JSON.stringify(existingHooks)) {
  const directory = join(await temp.create(), ".codex")
  await mkdir(directory)
  const configPath = join(directory, "config.toml")
  const hooksPath = join(directory, "hooks.json")
  await Bun.write(configPath, toml)
  await Bun.write(hooksPath, json)
  return { directory, configPath, hooksPath }
}

describe("Codex hook representation repair", () => {
  test("retains custom handlers, metadata, and unrelated configuration", async () => {
    const text =
      '# user preference\nmodel = "fixture-model"\n\n[mcp_servers.fixture]\ncommand = "fixture"\n\n' +
      inline
    const f = await fixture(text)
    const source = await inspectCodexHookSources(f.directory)
    expect(source.conflict).toBe(true)
    const result = await repairCodexHookSources(f.directory)
    expect(result.moved).toBe(1)
    const json = await Bun.file(f.hooksPath).json()
    expect(json.version).toBe(1)
    expect(json.hooks.SessionStart[0]).toEqual(existingHooks.hooks.SessionStart[0])
    expect(json.hooks.SessionStart[1]).toEqual({
      matcher: "startup|resume",
      hooks: [{ type: "command", command: "custom index", statusMessage: "Indexing", timeout: 2 }],
    })
    const changed = await Bun.file(f.configPath).text()
    expect(changed).toContain('# user preference\nmodel = "fixture-model"')
    expect(Bun.TOML.parse(changed)).toEqual({
      model: "fixture-model",
      mcp_servers: { fixture: { command: "fixture" } },
    })
    expect(await Bun.file(`${f.configPath}.bak`).text()).toBe(text)
    expect(await Bun.file(`${f.hooksPath}.bak`).text()).toBe(JSON.stringify(existingHooks))
    expect((await inspectCodexHookSources(f.directory)).conflict).toBe(false)
    expect((await repairCodexHookSources(f.directory)).changed).toBe(false)
    expect(await Bun.file(`${f.configPath}.bak`).text()).toBe(text)
  })

  test("dry run does not write configuration or backups", async () => {
    const f = await fixture()
    expect((await repairCodexHookSources(f.directory, { dryRun: true })).moved).toBe(1)
    expect(await Bun.file(f.configPath).text()).toBe(inline)
    expect(await Bun.file(f.hooksPath).text()).toBe(JSON.stringify(existingHooks))
    expect(await Bun.file(`${f.configPath}.bak`).exists()).toBe(false)
    expect(await Bun.file(`${f.hooksPath}.bak`).exists()).toBe(false)
  })

  test("trust state alone does not constitute a second definition source", async () => {
    const f = await fixture(
      '[hooks.state."existing-source"]\ntrusted_hash = "hash"\nenabled = false\n'
    )
    const source = await inspectCodexHookSources(f.directory)
    expect(source.conflict).toBe(false)
    expect(planCodexHookRepair(source)).toBeNull()
    expect((await repairCodexHookSources(f.directory)).changed).toBe(false)
    expect(await Bun.file(`${f.configPath}.bak`).exists()).toBe(false)
  })

  test("preserves old trust records and disabled behavior without granting new trust", async () => {
    const f = await fixture()
    const oldId = `${f.configPath}:session_start:0:0`
    const newId = `${f.hooksPath}:session_start:1:0`
    await Bun.write(
      f.configPath,
      `[hooks.state.${JSON.stringify(oldId)}]\ntrusted_hash = "original-hash"\nenabled = false\n\n` +
        inline
    )
    await repairCodexHookSources(f.directory)
    const parsed = Bun.TOML.parse(await Bun.file(f.configPath).text()) as {
      hooks: { state: Record<string, object> }
    }
    expect(parsed.hooks.state[oldId]).toEqual({ trusted_hash: "original-hash", enabled: false })
    expect(parsed.hooks.state[newId]).toEqual({ enabled: false })
  })

  test.each([
    'hooks.SessionStart = [{hooks = [{type = "command", command = "custom"}]}]',
    'hooks = {SessionStart = [{hooks = [{type = "command", command = "custom"}]}]}',
    '[hooks]\nSessionStart = [{hooks = [{type = "command", command = "custom"}]}]',
    '[["hooks"."SessionStart"]]\n[["hooks"."SessionStart"."hooks"]]\ntype = "command"\ncommand = "custom"',
    "[['hooks'.'SessionStart']]\n[['hooks'.'SessionStart'.'hooks']]\ntype = 'command'\ncommand = '''custom\n[projects.fake]\n'''",
  ])("supports TOML hook forms: %s", async (text) => {
    const f = await fixture(text)
    const before = await inspectCodexHookSources(f.directory)
    await repairCodexHookSources(f.directory)
    const after = await inspectCodexHookSources(f.directory)
    expect(after.conflict).toBe(false)
    expect(after.external.SessionStart?.at(-1)).toEqual(before.inline.SessionStart?.[0])
  })

  test.each([
    { toml: "not valid TOML =", json: "{}" },
    { toml: inline, json: "{broken" },
    { toml: inline, json: "[]" },
    { toml: 'hooks = "invalid"', json: "{}" },
    { toml: inline, json: '{"hooks":{"SessionStart":"invalid"}}' },
  ])("leaves malformed files untouched: %j", async ({ toml, json }) => {
    const f = await fixture(toml, json)
    await expect(repairCodexHookSources(f.directory)).rejects.toThrow("no files changed")
    expect(await Bun.file(f.configPath).text()).toBe(toml)
    expect(await Bun.file(f.hooksPath).text()).toBe(json)
    expect(await Bun.file(`${f.hooksPath}.bak`).exists()).toBe(false)
  })

  test("rolls back the destination if the source write fails", async () => {
    const f = await fixture()
    await expect(
      repairCodexHookSources(f.directory, {
        write: (path, text) =>
          path === f.configPath
            ? Promise.reject(new Error("simulated write failure"))
            : Bun.write(path, text),
      })
    ).rejects.toThrow("simulated write failure")
    expect(await Bun.file(f.hooksPath).text()).toBe(JSON.stringify(existingHooks))
    expect(await Bun.file(f.configPath).text()).toBe(inline)
    expect(await Bun.file(`${f.configPath}.bak`).text()).toBe(inline)
  })
})
