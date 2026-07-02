import { describe, expect, it } from "bun:test"
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

  it("registers and touches for an absolute cwd", () => {
    const ctx = makeCtx()
    registerProjectAndTouch(ctx, "/Users/me/proj")
    expect(ctx.registered).toEqual(["/Users/me/proj"])
    expect(ctx.touched).toEqual(["/Users/me/proj"])
  })

  it("no-ops for the '.' placeholder cwd (#716)", () => {
    const ctx = makeCtx()
    registerProjectAndTouch(ctx, ".")
    expect(ctx.registered).toEqual([])
    expect(ctx.touched).toEqual([])
  })
})
