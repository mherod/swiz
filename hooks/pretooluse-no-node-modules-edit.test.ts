import { describe, expect, test } from "bun:test"
import { runHook as runHookBase } from "../src/utils/test-utils.ts"

async function runHook(filePath: string) {
  return await runHookBase("hooks/pretooluse-no-node-modules-edit.ts", {
    tool_name: "Edit",
    tool_input: { file_path: filePath },
  })
}

describe("pretooluse-no-node-modules-edit", () => {
  describe("blocked paths", () => {
    test("exact match: node_modules/pkg/file.js", async () => {
      const result = await runHook("node_modules/pkg/file.js")
      expect(result.exitCode).toBe(0)
      expect(result.decision).toBe("deny")
    })

    test("uppercase: Node_Modules/pkg/file.js", async () => {
      const result = await runHook("Node_Modules/pkg/file.js")
      expect(result.exitCode).toBe(0)
      expect(result.decision).toBe("deny")
    })

    test("all-caps: NODE_MODULES/pkg/file.js", async () => {
      const result = await runHook("NODE_MODULES/pkg/file.js")
      expect(result.exitCode).toBe(0)
      expect(result.decision).toBe("deny")
    })

    test("absolute path: /project/node_modules/pkg/file.js", async () => {
      const result = await runHook("/project/node_modules/pkg/file.js")
      expect(result.exitCode).toBe(0)
      expect(result.decision).toBe("deny")
    })

    test("absolute path with mixed case: /project/Node_Modules/pkg/file.js", async () => {
      const result = await runHook("/project/Node_Modules/pkg/file.js")
      expect(result.exitCode).toBe(0)
      expect(result.decision).toBe("deny")
    })

    test("Windows-style path: project\\node_modules\\pkg\\file.js", async () => {
      const result = await runHook("project\\node_modules\\pkg\\file.js")
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

    test("file with node_modules in name but not as directory segment", async () => {
      const result = await runHook("/project/src/my-node_modules-helper.ts")
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
