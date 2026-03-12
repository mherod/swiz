import { describe, expect, test } from "bun:test"

interface HookResult {
  exitCode: number | null
  decision?: string
  reason?: string
}

async function runHook(filePath: string): Promise<HookResult> {
  const payload = JSON.stringify({
    tool_name: "Edit",
    tool_input: { file_path: filePath },
  })

  const proc = Bun.spawn(["bun", "hooks/pretooluse-no-node-modules-edit.ts"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  void proc.stdin.write(payload)
  void proc.stdin.end()

  const stdout = await new Response(proc.stdout).text()
  await proc.exited

  let decision: string | undefined
  let reason: string | undefined

  if (stdout.trim()) {
    try {
      const parsed = JSON.parse(stdout.trim())
      const hso = parsed.hookSpecificOutput as Record<string, unknown> | undefined
      decision = (hso?.permissionDecision ?? parsed.decision) as string | undefined
      reason = (hso?.permissionDecisionReason ?? parsed.reason) as string | undefined
    } catch {}
  }

  return { exitCode: proc.exitCode, decision, reason }
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
