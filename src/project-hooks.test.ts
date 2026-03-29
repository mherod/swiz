import { describe, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import type { HookGroup } from "./manifest.ts"
import { readProjectSettings, resolveProjectHooks } from "./settings.ts"
import { useTempDir } from "./utils/test-utils.ts"

const { create: createTempDir } = useTempDir("swiz-project-hooks-")

describe("ProjectSwizSettings hooks normalization", () => {
  test("reads hooks from .swiz/config.json", async () => {
    const dir = await createTempDir()
    await mkdir(join(dir, ".swiz"), { recursive: true })
    await Bun.write(
      join(dir, ".swiz", "config.json"),
      JSON.stringify({
        hooks: [
          {
            event: "preToolUse",
            hooks: [{ file: "scripts/check.ts", timeout: 5 }],
          },
        ],
      })
    )

    const settings = await readProjectSettings(dir)
    expect(settings?.hooks).toHaveLength(1)
    expect(settings!.hooks![0]!.event).toBe("preToolUse")
    expect(settings!.hooks![0]!.hooks[0]!.file).toBe("scripts/check.ts")
    expect(settings!.hooks![0]!.hooks[0]!.timeout).toBe(5)
  })

  test("ignores invalid hook entries (missing file)", async () => {
    const dir = await createTempDir()
    await mkdir(join(dir, ".swiz"), { recursive: true })
    await Bun.write(
      join(dir, ".swiz", "config.json"),
      JSON.stringify({
        hooks: [
          {
            event: "stop",
            hooks: [{ timeout: 5 }], // no file field
          },
        ],
      })
    )

    const settings = await readProjectSettings(dir)
    // Group with no valid hooks is dropped
    expect(settings?.hooks).toBeUndefined()
  })

  test("ignores hook groups with missing event", async () => {
    const dir = await createTempDir()
    await mkdir(join(dir, ".swiz"), { recursive: true })
    await Bun.write(
      join(dir, ".swiz", "config.json"),
      JSON.stringify({
        hooks: [{ hooks: [{ file: "check.ts" }] }], // no event
      })
    )

    const settings = await readProjectSettings(dir)
    expect(settings?.hooks).toBeUndefined()
  })

  test("preserves cooldownSeconds on hooks", async () => {
    const dir = await createTempDir()
    await mkdir(join(dir, ".swiz"), { recursive: true })
    await Bun.write(
      join(dir, ".swiz", "config.json"),
      JSON.stringify({
        hooks: [
          {
            event: "stop",
            hooks: [{ file: "rate-limited.ts", cooldownSeconds: 60 }],
          },
        ],
      })
    )

    const settings = await readProjectSettings(dir)
    expect(settings!.hooks![0]!.hooks[0]!.cooldownSeconds).toBe(60)
  })

  test("preserves stacks on hooks", async () => {
    const dir = await createTempDir()
    await mkdir(join(dir, ".swiz"), { recursive: true })
    await Bun.write(
      join(dir, ".swiz", "config.json"),
      JSON.stringify({
        hooks: [
          {
            event: "preToolUse",
            hooks: [{ file: "node-only.ts", stacks: ["bun", "node"] }],
          },
        ],
      })
    )

    const settings = await readProjectSettings(dir)
    expect(settings!.hooks![0]!.hooks[0]!.stacks).toEqual(["bun", "node"])
  })

  test("ignores stacks with non-string values", async () => {
    const dir = await createTempDir()
    await mkdir(join(dir, ".swiz"), { recursive: true })
    await Bun.write(
      join(dir, ".swiz", "config.json"),
      JSON.stringify({
        hooks: [
          {
            event: "preToolUse",
            hooks: [{ file: "bad-stacks.ts", stacks: [1, 2] }],
          },
        ],
      })
    )

    const settings = await readProjectSettings(dir)
    // Hook is preserved but stacks is dropped (invalid type)
    expect(settings!.hooks![0]!.hooks[0]!.file).toBe("bad-stacks.ts")
    expect(settings!.hooks![0]!.hooks[0]!.stacks).toBeUndefined()
  })

  test("preserves matcher field on hook groups", async () => {
    const dir = await createTempDir()
    await mkdir(join(dir, ".swiz"), { recursive: true })
    await Bun.write(
      join(dir, ".swiz", "config.json"),
      JSON.stringify({
        hooks: [
          {
            event: "preToolUse",
            matcher: "Bash",
            hooks: [{ file: "check-bash.ts" }],
          },
        ],
      })
    )

    const settings = await readProjectSettings(dir)
    expect(settings!.hooks![0]!.matcher).toBe("Bash")
  })
})

describe("resolveProjectHooks", () => {
  test("resolves relative paths to absolute", () => {
    const hooks: HookGroup[] = [{ event: "stop", hooks: [{ file: "scripts/check.ts" }] }]
    // Create the file so it passes validation
    const dir = `/tmp/swiz-resolve-test-${Date.now()}`
    const { resolved } = resolveProjectHooks(hooks, dir)
    // Files don't exist, so they'll be filtered out with warnings
    expect(resolved).toHaveLength(0)
  })

  test("warns about missing hook files", () => {
    const hooks: HookGroup[] = [{ event: "stop", hooks: [{ file: "missing.ts" }] }]
    const { warnings } = resolveProjectHooks(hooks, "/nonexistent")
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("not found")
    expect(warnings[0]).toContain("missing.ts")
  })

  test("resolves existing hook files", async () => {
    const dir = await createTempDir()
    await Bun.write(join(dir, "my-hook.ts"), "// hook")

    const hooks: HookGroup[] = [{ event: "stop", hooks: [{ file: "my-hook.ts" }] }]
    const { resolved, warnings } = resolveProjectHooks(hooks, dir)

    expect(warnings).toHaveLength(0)
    expect(resolved).toHaveLength(1)
    expect(resolved[0]!.hooks[0]!.file).toBe(join(dir, "my-hook.ts"))
  })

  test("preserves absolute paths", async () => {
    const dir = await createTempDir()
    const absPath = join(dir, "abs-hook.ts")
    await Bun.write(absPath, "// hook")

    const hooks: HookGroup[] = [{ event: "stop", hooks: [{ file: absPath }] }]
    const { resolved } = resolveProjectHooks(hooks, "/other")

    expect(resolved).toHaveLength(1)
    expect(resolved[0]!.hooks[0]!.file).toBe(absPath)
  })

  test("filters out groups where all files are missing", () => {
    const hooks: HookGroup[] = [
      { event: "stop", hooks: [{ file: "gone.ts" }] },
      { event: "preToolUse", hooks: [{ file: "also-gone.ts" }] },
    ]
    const { resolved, warnings } = resolveProjectHooks(hooks, "/nonexistent")

    expect(resolved).toHaveLength(0)
    expect(warnings).toHaveLength(2)
  })

  test("keeps groups with at least one valid file", async () => {
    const dir = await createTempDir()
    await Bun.write(join(dir, "good.ts"), "// hook")

    const hooks: HookGroup[] = [
      { event: "stop", hooks: [{ file: "good.ts" }, { file: "missing.ts" }] },
    ]
    const { resolved, warnings } = resolveProjectHooks(hooks, dir)

    expect(resolved).toHaveLength(1)
    expect(resolved[0]!.hooks).toHaveLength(1)
    expect(resolved[0]!.hooks[0]!.file).toBe(join(dir, "good.ts"))
    expect(warnings).toHaveLength(1)
  })
})
