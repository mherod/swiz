import { describe, expect, test } from "bun:test"
import { isSandboxDisableCommand } from "./pretooluse-protect-sandbox.ts"
import { runBashHook, runFileEditHook } from "./test-utils.ts"

const HOOK = "hooks/pretooluse-protect-sandbox.ts"

describe("isSandboxDisableCommand", () => {
  test("matches swiz settings disable sandboxed-edits", () => {
    expect(isSandboxDisableCommand("swiz settings disable sandboxed-edits")).toBe(true)
  })

  test("matches swiz settings disable sandboxededits", () => {
    expect(isSandboxDisableCommand("swiz settings disable sandboxededits")).toBe(true)
  })

  test("matches swiz settings set sandboxedEdits false", () => {
    expect(isSandboxDisableCommand("swiz settings set sandboxedEdits false")).toBe(true)
  })

  test("does not match unrelated settings commands", () => {
    expect(isSandboxDisableCommand("swiz settings enable sandboxed-edits")).toBe(false)
    expect(isSandboxDisableCommand("swiz settings disable autoContinue")).toBe(false)
    expect(isSandboxDisableCommand("echo hello")).toBe(false)
  })
})

describe("pretooluse-protect-sandbox (shell commands)", () => {
  test("blocks swiz settings disable sandboxed-edits", async () => {
    const result = await runBashHook(HOOK, "swiz settings disable sandboxed-edits")
    expect(result.decision).toBe("deny")
  })

  test("allows unrelated shell commands", async () => {
    const result = await runBashHook(HOOK, "git status")
    expect(result.decision).toBeUndefined()
  })
})

describe("pretooluse-protect-sandbox (file edits)", () => {
  test("blocks Edit to .swiz/config.json", async () => {
    const result = await runFileEditHook(HOOK, {
      filePath: "/some/project/.swiz/config.json",
      newString: '{"sandboxedEdits": false}',
    })
    expect(result.decision).toBe("deny")
  })

  test("blocks Write to .swiz/config.json", async () => {
    const result = await runFileEditHook(HOOK, {
      toolName: "Write",
      filePath: "/some/project/.swiz/config.json",
      content: '{"strictNoDirectMain": false}',
    })
    expect(result.decision).toBe("deny")
  })

  test("blocks .swiz/settings.json edits", async () => {
    const result = await runFileEditHook(HOOK, {
      filePath: "/some/project/.swiz/settings.json",
      newString: "{}",
    })
    expect(result.decision).toBe("deny")
  })

  test("allows edits to non-swiz files", async () => {
    const result = await runFileEditHook(HOOK, {
      filePath: "/some/project/src/app.ts",
      newString: "export default {}",
    })
    expect(result.decision).toBeUndefined()
  })

  test("allows edits to files that contain .swiz in their name but are not in .swiz/", async () => {
    const result = await runFileEditHook(HOOK, {
      filePath: "/some/project/src/.swiz-backup.json",
    })
    // .swiz-backup.json is not inside a .swiz/ directory — should be allowed
    expect(result.decision).toBeUndefined()
  })
})
