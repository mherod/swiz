import { describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { canonicalizePath } from "../../project-identity.ts"
import { isRegisterableProjectCwd, registerProjectAndTouch } from "./route-helpers.ts"

describe("isRegisterableProjectCwd", () => {
  it("accepts absolute paths", () => {
    expect(isRegisterableProjectCwd("/Users/me/proj")).toBe(true)
    expect(isRegisterableProjectCwd("/")).toBe(true)
  })

  it("rejects placeholder and relative cwds (#716)", () => {
    expect(isRegisterableProjectCwd(".")).toBe(false)
    expect(isRegisterableProjectCwd("./proj")).toBe(false)
    expect(isRegisterableProjectCwd("")).toBe(false)
    expect(isRegisterableProjectCwd("proj")).toBe(false)
  })
})

describe("registerProjectAndTouch", () => {
  function makeCtx() {
    const registered: string[] = []
    const touched: string[] = []
    return {
      registered,
      touched,
      registerProjectWatchers: (cwd: string) => registered.push(cwd),
      touchProject: (cwd: string) => touched.push(cwd),
    }
  }

  it("registers and touches for an absolute cwd", async () => {
    const ctx = makeCtx()
    await registerProjectAndTouch(ctx, "/Users/me/proj")
    expect(ctx.registered).toEqual(["/Users/me/proj"])
    expect(ctx.touched).toEqual(["/Users/me/proj"])
  })

  it("no-ops for the '.' placeholder cwd (#716)", async () => {
    const ctx = makeCtx()
    await registerProjectAndTouch(ctx, ".")
    expect(ctx.registered).toEqual([])
    expect(ctx.touched).toEqual([])
  })

  it("uses one canonical root for subdirectory and symlink route cwds (#717)", async () => {
    const base = await mkdtemp(join(tmpdir(), "swiz-route-project-"))
    const root = join(base, "repo")
    const nested = join(root, "src", "nested")
    const alias = join(base, "alias")
    await mkdir(join(root, ".git"), { recursive: true })
    await mkdir(nested, { recursive: true })
    await symlink(root, alias)

    const ctx = makeCtx()
    try {
      await registerProjectAndTouch(ctx, nested)
      await registerProjectAndTouch(ctx, alias)

      const canonicalRoot = canonicalizePath(root)
      expect(ctx.registered).toEqual([canonicalRoot, canonicalRoot])
      expect(ctx.touched).toEqual([canonicalRoot, canonicalRoot])
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })
})
