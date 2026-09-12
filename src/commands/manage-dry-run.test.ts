import { describe, expect, test } from "bun:test"
import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { runCommandInProcess, useTempDir } from "../utils/test-utils.ts"
import { manageCommand } from "./manage.ts"

const tmp = useTempDir("swiz-manage-dry-run-")

async function run(args: string[], home: string) {
  return await runCommandInProcess(manageCommand, ["mcp", ...args], {
    commandOptions: { home, cwd: home },
    env: { HOME: home },
  })
}

describe("MCP add/remove previews", () => {
  test("previews every default target without creating files or directories", async () => {
    const home = await tmp.create()
    const result = await run(["add", "preview", "--command", "bun", "--dry-run"], home)
    expect(result.exitCode).toBe(0)
    expect(result.stdout.match(/Would add/g)).toHaveLength(8)
    expect(result.stdout).toContain(join(home, ".codex", "config.toml"))
    expect(result.stdout).toContain(join(home, ".cursor", "mcp.json"))
    expect(await readdir(home)).toEqual([])
  })

  test.each(["add", "remove"])("%s preview preserves JSON, TOML and backups", async (action) => {
    const home = await tmp.create()
    const targets = ["--cursor", "--codex"]
    expect((await run(["add", "preview", "--command", "bun", ...targets], home)).exitCode).toBe(0)
    const paths = [join(home, ".cursor", "mcp.json"), join(home, ".codex", "config.toml")]
    const before = await Promise.all(paths.map((path) => Bun.file(path).text()))
    const entries = (await readdir(home, { recursive: true })).sort()
    const definition = action === "add" ? ["--url", "https://example.com/mcp"] : []
    const result = await run([action, "preview", ...definition, ...targets, "--dry-run"], home)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain(`Would ${action} "preview"`)
    expect(await Promise.all(paths.map((path) => Bun.file(path).text()))).toEqual(before)
    expect((await readdir(home, { recursive: true })).sort()).toEqual(entries)
  })

  test("project preview uses project paths and missing remove stays a no-op", async () => {
    const home = await tmp.create()
    const result = await run(
      ["add", "preview", "--command", "bun", "--claude", "--project", "--dry-run"],
      home
    )
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain(join(home, ".mcp.json"))
    const removed = await run(["remove", "missing", "--cursor", "--dry-run"], home)
    expect(removed.exitCode).toBe(0)
    expect(removed.stdout).toContain("not found")
    expect(await readdir(home)).toEqual([])
  })

  test("preview still validates the requested transport", async () => {
    const home = await tmp.create()
    const result = await run(["add", "preview", "--dry-run"], home)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("requires exactly one")
    expect(await readdir(home)).toEqual([])
  })
})
