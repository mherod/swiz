import { describe, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import type { HookGroup } from "./manifest.ts"
import { loadAllPlugins } from "./plugins.ts"
import { useTempDir } from "./utils/test-utils.ts"

const { create: createTempDir } = useTempDir("swiz-plugin-test-")

describe("loadAllPlugins", () => {
  test("loads a local path plugin with swiz-hooks.json", async () => {
    const projectRoot = await createTempDir()
    const pluginDir = join(projectRoot, "my-hooks")
    await mkdir(pluginDir, { recursive: true })

    const hooks: HookGroup[] = [
      {
        event: "preToolUse",
        hooks: [{ file: "check-imports.ts", timeout: 5 }],
      },
    ]
    await Bun.write(join(pluginDir, "swiz-hooks.json"), JSON.stringify(hooks))

    const results = await loadAllPlugins(["./my-hooks"], projectRoot)

    expect(results).toHaveLength(1)
    expect(results[0]!.name).toBe("./my-hooks")
    expect(results[0]!.error).toBeUndefined()
    expect(results[0]!.errorCode).toBeUndefined()
    expect(results[0]!.hooks).toHaveLength(1)
    expect(results[0]!.hooks[0]!.event).toBe("preToolUse")
    // Path should be resolved to absolute
    expect(results[0]!.hooks[0]!.hooks[0]!.file).toBe(join(pluginDir, "check-imports.ts"))
  })

  test("returns error for missing npm plugin", async () => {
    const projectRoot = await createTempDir()

    const results = await loadAllPlugins(["swiz-plugin-nonexistent"], projectRoot)

    expect(results).toHaveLength(1)
    expect(results[0]!.name).toBe("swiz-plugin-nonexistent")
    expect(results[0]!.errorCode).toBe("not-found")
    expect(results[0]!.error).toContain("Plugin not found")
    expect(results[0]!.hooks).toHaveLength(0)
  })

  test("returns error for local path with no entry points", async () => {
    const projectRoot = await createTempDir()

    const results = await loadAllPlugins(["./nonexistent-hooks"], projectRoot)

    expect(results).toHaveLength(1)
    expect(results[0]!.errorCode).toBe("no-entry-point")
    expect(results[0]!.error).toContain("No swiz-hooks.ts or swiz-hooks.json")
    expect(results[0]!.hooks).toHaveLength(0)
  })

  test("returns error when plugin has no entry point", async () => {
    const projectRoot = await createTempDir()
    const pluginDir = join(projectRoot, "empty-plugin")
    await mkdir(pluginDir, { recursive: true })
    // No swiz-hooks.ts or swiz-hooks.json

    const results = await loadAllPlugins(["./empty-plugin"], projectRoot)

    expect(results).toHaveLength(1)
    expect(results[0]!.errorCode).toBe("no-entry-point")
    expect(results[0]!.error).toContain("No swiz-hooks.ts or swiz-hooks.json")
  })

  test("returns error for invalid JSON in swiz-hooks.json", async () => {
    const projectRoot = await createTempDir()
    const pluginDir = join(projectRoot, "bad-json")
    await mkdir(pluginDir, { recursive: true })
    await Bun.write(join(pluginDir, "swiz-hooks.json"), "not json")

    const results = await loadAllPlugins(["./bad-json"], projectRoot)

    expect(results).toHaveLength(1)
    expect(results[0]!.errorCode).toBe("parse-error")
    expect(results[0]!.error).toContain("Failed to load")
  })

  test("returns error when swiz-hooks.json is not an array", async () => {
    const projectRoot = await createTempDir()
    const pluginDir = join(projectRoot, "not-array")
    await mkdir(pluginDir, { recursive: true })
    await Bun.write(join(pluginDir, "swiz-hooks.json"), JSON.stringify({ event: "stop" }))

    const results = await loadAllPlugins(["./not-array"], projectRoot)

    expect(results).toHaveLength(1)
    expect(results[0]!.errorCode).toBe("invalid-export")
    expect(results[0]!.error).toContain("is not a HookGroup[]")
  })

  test("loads multiple plugins and preserves order", async () => {
    const projectRoot = await createTempDir()

    // Plugin A
    const pluginA = join(projectRoot, "plugin-a")
    await mkdir(pluginA, { recursive: true })
    const hooksA: HookGroup[] = [{ event: "stop", hooks: [{ file: "a.ts" }] }]
    await Bun.write(join(pluginA, "swiz-hooks.json"), JSON.stringify(hooksA))

    // Plugin B
    const pluginB = join(projectRoot, "plugin-b")
    await mkdir(pluginB, { recursive: true })
    const hooksB: HookGroup[] = [{ event: "preToolUse", hooks: [{ file: "b.ts" }] }]
    await Bun.write(join(pluginB, "swiz-hooks.json"), JSON.stringify(hooksB))

    const results = await loadAllPlugins(["./plugin-a", "./plugin-b"], projectRoot)

    expect(results).toHaveLength(2)
    expect(results[0]!.name).toBe("./plugin-a")
    expect(results[1]!.name).toBe("./plugin-b")
    expect(results[0]!.hooks[0]!.event).toBe("stop")
    expect(results[1]!.hooks[0]!.event).toBe("preToolUse")
  })

  test("resolves hook file paths relative to plugin directory", async () => {
    const projectRoot = await createTempDir()
    const pluginDir = join(projectRoot, "nested", "hooks")
    await mkdir(pluginDir, { recursive: true })

    const hooks: HookGroup[] = [
      {
        event: "stop",
        hooks: [{ file: "scripts/my-check.ts" }, { file: "/absolute/path.ts" }],
      },
    ]
    await Bun.write(join(pluginDir, "swiz-hooks.json"), JSON.stringify(hooks))

    const results = await loadAllPlugins(["./nested/hooks"], projectRoot)

    expect(results[0]!.hooks[0]!.hooks[0]!.file).toBe(join(pluginDir, "scripts/my-check.ts"))
    // Absolute paths should be preserved
    expect(results[0]!.hooks[0]!.hooks[1]!.file).toBe("/absolute/path.ts")
  })

  test("continues loading after a failed plugin", async () => {
    const projectRoot = await createTempDir()

    // Valid plugin
    const validDir = join(projectRoot, "valid")
    await mkdir(validDir, { recursive: true })
    const hooks: HookGroup[] = [{ event: "stop", hooks: [{ file: "ok.ts" }] }]
    await Bun.write(join(validDir, "swiz-hooks.json"), JSON.stringify(hooks))

    const results = await loadAllPlugins(["./missing", "./valid"], projectRoot)

    expect(results).toHaveLength(2)
    expect(results[0]!.errorCode).toBe("no-entry-point")
    expect(results[1]!.errorCode).toBeUndefined()
    expect(results[1]!.hooks).toHaveLength(1)
  })

  test("returns empty results for empty plugin list", async () => {
    const projectRoot = await createTempDir()
    const results = await loadAllPlugins([], projectRoot)
    expect(results).toHaveLength(0)
  })
})
