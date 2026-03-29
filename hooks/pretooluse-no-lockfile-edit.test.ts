import { describe, expect, test } from "bun:test"
import { runHook as runHookBase } from "../src/utils/test-utils.ts"

async function runHook(filePath: string) {
  return runHookBase("hooks/pretooluse-no-lockfile-edit.ts", {
    tool_name: "Edit",
    tool_input: { file_path: filePath },
  })
}

describe("pretooluse-no-lockfile-edit", () => {
  describe("blocked lockfiles", () => {
    test("pnpm-lock.yaml", async () => {
      const result = await runHook("pnpm-lock.yaml")
      expect(result.exitCode).toBe(0)
      expect(result.decision).toBe("deny")
    })

    test("package-lock.json", async () => {
      const result = await runHook("package-lock.json")
      expect(result.exitCode).toBe(0)
      expect(result.decision).toBe("deny")
    })

    test("yarn.lock", async () => {
      const result = await runHook("yarn.lock")
      expect(result.exitCode).toBe(0)
      expect(result.decision).toBe("deny")
    })

    test("bun.lock", async () => {
      const result = await runHook("bun.lock")
      expect(result.exitCode).toBe(0)
      expect(result.decision).toBe("deny")
    })

    test("bun.lockb", async () => {
      const result = await runHook("bun.lockb")
      expect(result.exitCode).toBe(0)
      expect(result.decision).toBe("deny")
    })

    test("npm-shrinkwrap.json", async () => {
      const result = await runHook("npm-shrinkwrap.json")
      expect(result.exitCode).toBe(0)
      expect(result.decision).toBe("deny")
    })

    test("shrinkwrap.yaml", async () => {
      const result = await runHook("shrinkwrap.yaml")
      expect(result.exitCode).toBe(0)
      expect(result.decision).toBe("deny")
    })

    test("absolute path: /project/pnpm-lock.yaml", async () => {
      const result = await runHook("/project/pnpm-lock.yaml")
      expect(result.exitCode).toBe(0)
      expect(result.decision).toBe("deny")
    })

    test("nested workspace: packages/app/package-lock.json", async () => {
      const result = await runHook("packages/app/package-lock.json")
      expect(result.exitCode).toBe(0)
      expect(result.decision).toBe("deny")
    })

    test("uppercase: PNPM-LOCK.YAML", async () => {
      const result = await runHook("PNPM-LOCK.YAML")
      expect(result.exitCode).toBe(0)
      expect(result.decision).toBe("deny")
    })

    test("Windows-style path: project\\yarn.lock", async () => {
      const result = await runHook("project\\yarn.lock")
      expect(result.exitCode).toBe(0)
      expect(result.decision).toBe("deny")
    })
  })

  describe("allowed paths", () => {
    test("source file: /project/src/file.ts", async () => {
      const result = await runHook("/project/src/file.ts")
      expect(result.exitCode).toBe(0)
      expect(result.decision).toBe("allow")
    })

    test("file with lockfile name as prefix: bun.lock.backup", async () => {
      const result = await runHook("bun.lock.backup")
      expect(result.exitCode).toBe(0)
      expect(result.decision).toBe("allow")
    })

    test("file mentioning lockfile in name: my-yarn.lock-helper.ts", async () => {
      const result = await runHook("/project/src/my-yarn.lock-helper.ts")
      expect(result.exitCode).toBe(0)
      expect(result.decision).toBe("allow")
    })

    test("package.json (not a lockfile)", async () => {
      const result = await runHook("package.json")
      expect(result.exitCode).toBe(0)
      expect(result.decision).toBe("allow")
    })

    test("empty path", async () => {
      const result = await runHook("")
      expect(result.exitCode).toBe(0)
      expect(result.decision).toBe("allow")
    })
  })
})
