import { describe, expect, test } from "bun:test"

type JsonObject = Record<string, unknown>

/**
 * Run an inline bun script that imports and calls a hook-utils helper.
 * This avoids mocking process.exit — the helper runs in a real subprocess.
 */
async function runHelper(code: string): Promise<{
  exitCode: number | null
  parsed: JsonObject
  stdout: string
}> {
  const script = `import { ${code}`
  const proc = Bun.spawn(["bun", "-e", script], {
    stdout: "pipe",
    stderr: "pipe",
    cwd: import.meta.dir,
  })
  const stdout = await new Response(proc.stdout).text()
  await proc.exited
  const trimmed = stdout.trim()
  return {
    exitCode: proc.exitCode,
    parsed: trimmed ? (JSON.parse(trimmed) as JsonObject) : {},
    stdout: trimmed,
  }
}

describe("denyPreToolUse", () => {
  test("emits deny decision with reason", async () => {
    const { exitCode, parsed } = await runHelper(
      `denyPreToolUse } from "./hook-utils.ts"; denyPreToolUse("blocked for testing")`
    )
    expect(exitCode).toBe(0)
    const hso = parsed.hookSpecificOutput as JsonObject
    expect(hso.hookEventName).toBe("PreToolUse")
    expect(hso.permissionDecision).toBe("deny")
    expect(hso.permissionDecisionReason as string).toStartWith("blocked for testing")
    expect(hso).not.toHaveProperty("updatedInput")
  })

  test("includes a cause summary in the update-memory reminder", async () => {
    const { parsed } = await runHelper(
      `denyPreToolUse } from "./hook-utils.ts"; ` +
        `denyPreToolUse("The user asked for a changelog update before stopping.")`
    )
    const hso = parsed.hookSpecificOutput as JsonObject
    const reason = hso.permissionDecisionReason as string
    expect(reason).toContain("Cause to capture:")
    expect(reason).toContain("A user instruction was missed")
    expect(reason).toContain("The user asked for a changelog update before stopping.")
  })
})

describe("allowPreToolUseWithUpdatedInput", () => {
  test("emits allow decision with updatedInput", async () => {
    const { exitCode, parsed } = await runHelper(
      `allowPreToolUseWithUpdatedInput } from "./hook-utils.ts"; ` +
        `allowPreToolUseWithUpdatedInput({ command: "echo safe" })`
    )
    expect(exitCode).toBe(0)
    const hso = parsed.hookSpecificOutput as JsonObject
    expect(hso.hookEventName).toBe("PreToolUse")
    expect(hso.permissionDecision).toBe("allow")
    expect(hso.updatedInput).toEqual({ command: "echo safe" })
    expect(hso).not.toHaveProperty("permissionDecisionReason")
  })

  test("includes reason when provided", async () => {
    const { exitCode, parsed } = await runHelper(
      `allowPreToolUseWithUpdatedInput } from "./hook-utils.ts"; ` +
        `allowPreToolUseWithUpdatedInput({ file_path: "/tmp/safe.ts" }, "Sanitized path")`
    )
    expect(exitCode).toBe(0)
    const hso = parsed.hookSpecificOutput as JsonObject
    expect(hso.permissionDecision).toBe("allow")
    expect(hso.permissionDecisionReason).toBe("Sanitized path")
    expect(hso.updatedInput).toEqual({ file_path: "/tmp/safe.ts" })
  })

  test("omits reason when undefined", async () => {
    const { exitCode, parsed } = await runHelper(
      `allowPreToolUseWithUpdatedInput } from "./hook-utils.ts"; ` +
        `allowPreToolUseWithUpdatedInput({ key: "value" }, undefined)`
    )
    expect(exitCode).toBe(0)
    const hso = parsed.hookSpecificOutput as JsonObject
    expect(hso).not.toHaveProperty("permissionDecisionReason")
  })

  test("omits reason when empty string", async () => {
    const { exitCode, parsed } = await runHelper(
      `allowPreToolUseWithUpdatedInput } from "./hook-utils.ts"; ` +
        `allowPreToolUseWithUpdatedInput({ key: "value" }, "")`
    )
    expect(exitCode).toBe(0)
    const hso = parsed.hookSpecificOutput as JsonObject
    expect(hso).not.toHaveProperty("permissionDecisionReason")
  })

  test("handles complex updatedInput objects", async () => {
    const { exitCode, parsed } = await runHelper(
      `allowPreToolUseWithUpdatedInput } from "./hook-utils.ts"; ` +
        `allowPreToolUseWithUpdatedInput({ command: "ls -la", timeout: 5000, description: "List files" })`
    )
    expect(exitCode).toBe(0)
    const hso = parsed.hookSpecificOutput as JsonObject
    expect(hso.updatedInput).toEqual({
      command: "ls -la",
      timeout: 5000,
      description: "List files",
    })
  })
})

describe("denyPreToolUse edge cases", () => {
  test("handles empty string reason", async () => {
    const { exitCode, parsed } = await runHelper(
      `denyPreToolUse } from "./hook-utils.ts"; denyPreToolUse("")`
    )
    expect(exitCode).toBe(0)
    const hso = parsed.hookSpecificOutput as JsonObject
    expect(hso.permissionDecision).toBe("deny")
    // Footer is always appended; empty caller reason → only the footer
    expect(hso.permissionDecisionReason).toContain("ACTION REQUIRED")
  })

  test("handles reason with special characters", async () => {
    const { exitCode, parsed } = await runHelper(
      `denyPreToolUse } from "./hook-utils.ts"; denyPreToolUse("Line1\\nLine2\\t\\"quoted\\"\\\\backslash")`
    )
    expect(exitCode).toBe(0)
    const hso = parsed.hookSpecificOutput as JsonObject
    expect(hso.permissionDecisionReason as string).toStartWith('Line1\nLine2\t"quoted"\\backslash')
  })

  test("handles very long reason string", async () => {
    const { exitCode, parsed } = await runHelper(
      `denyPreToolUse } from "./hook-utils.ts"; denyPreToolUse("x".repeat(10000))`
    )
    expect(exitCode).toBe(0)
    const hso = parsed.hookSpecificOutput as JsonObject
    // Footer is appended after the 10,000-char reason
    expect(hso.permissionDecisionReason as string).toStartWith("x".repeat(10000))
  })

  test("handles reason with unicode characters", async () => {
    const { exitCode, parsed } = await runHelper(
      `denyPreToolUse } from "./hook-utils.ts"; denyPreToolUse("Blocked: \u{1F6AB} forbidden \u{2714} checked")`
    )
    expect(exitCode).toBe(0)
    const hso = parsed.hookSpecificOutput as JsonObject
    expect(hso.permissionDecisionReason).toContain("\u{1F6AB}")
  })

  test("output is exactly one JSON object (no trailing content)", async () => {
    const { stdout } = await runHelper(
      `denyPreToolUse } from "./hook-utils.ts"; denyPreToolUse("single output")`
    )
    // Verify stdout is a single valid JSON object — no extra lines
    expect(() => JSON.parse(stdout)).not.toThrow()
    expect(stdout.split("\n").filter(Boolean).length).toBe(1)
  })
})

describe("allowPreToolUseWithUpdatedInput edge cases", () => {
  test("handles empty updatedInput object", async () => {
    const { exitCode, parsed } = await runHelper(
      `allowPreToolUseWithUpdatedInput } from "./hook-utils.ts"; ` +
        `allowPreToolUseWithUpdatedInput({})`
    )
    expect(exitCode).toBe(0)
    const hso = parsed.hookSpecificOutput as JsonObject
    expect(hso.permissionDecision).toBe("allow")
    expect(hso.updatedInput).toEqual({})
  })

  test("handles updatedInput with null values", async () => {
    const { exitCode, parsed } = await runHelper(
      `allowPreToolUseWithUpdatedInput } from "./hook-utils.ts"; ` +
        `allowPreToolUseWithUpdatedInput({ command: null, timeout: null })`
    )
    expect(exitCode).toBe(0)
    const hso = parsed.hookSpecificOutput as JsonObject
    expect(hso.updatedInput).toEqual({ command: null, timeout: null })
  })

  test("handles updatedInput with nested objects", async () => {
    const { exitCode, parsed } = await runHelper(
      `allowPreToolUseWithUpdatedInput } from "./hook-utils.ts"; ` +
        `allowPreToolUseWithUpdatedInput({ options: { verbose: true, nested: { deep: 1 } } })`
    )
    expect(exitCode).toBe(0)
    const hso = parsed.hookSpecificOutput as JsonObject
    const input = hso.updatedInput as JsonObject
    expect(input.options).toEqual({ verbose: true, nested: { deep: 1 } })
  })

  test("handles updatedInput with array values", async () => {
    const { exitCode, parsed } = await runHelper(
      `allowPreToolUseWithUpdatedInput } from "./hook-utils.ts"; ` +
        `allowPreToolUseWithUpdatedInput({ args: ["--flag", "-v"], paths: [] })`
    )
    expect(exitCode).toBe(0)
    const hso = parsed.hookSpecificOutput as JsonObject
    const input = hso.updatedInput as JsonObject
    expect(input.args).toEqual(["--flag", "-v"])
    expect(input.paths).toEqual([])
  })

  test("handles updatedInput with special string values", async () => {
    const { exitCode, parsed } = await runHelper(
      `allowPreToolUseWithUpdatedInput } from "./hook-utils.ts"; ` +
        `allowPreToolUseWithUpdatedInput({ command: "echo \\"hello world\\"\\n" })`
    )
    expect(exitCode).toBe(0)
    const hso = parsed.hookSpecificOutput as JsonObject
    const input = hso.updatedInput as JsonObject
    expect(input.command).toBe('echo "hello world"\n')
  })

  test("output is exactly one JSON object (no trailing content)", async () => {
    const { stdout } = await runHelper(
      `allowPreToolUseWithUpdatedInput } from "./hook-utils.ts"; ` +
        `allowPreToolUseWithUpdatedInput({ key: "value" })`
    )
    expect(() => JSON.parse(stdout)).not.toThrow()
    expect(stdout.split("\n").filter(Boolean).length).toBe(1)
  })
})

describe("PreToolUse helper isolation (integration)", () => {
  test("sequential deny calls produce independent outputs", async () => {
    const results: JsonObject[] = []
    for (const reason of ["reason-A", "reason-B", "reason-C"]) {
      const { parsed } = await runHelper(
        `denyPreToolUse } from "./hook-utils.ts"; denyPreToolUse("${reason}")`
      )
      results.push(parsed)
    }
    const reasons = ["reason-A", "reason-B", "reason-C"]
    for (const [i, result] of results.entries()) {
      const hso = result.hookSpecificOutput as JsonObject
      expect(hso.permissionDecision).toBe("deny")
      expect(hso.permissionDecisionReason as string).toStartWith(reasons[i]!)
      expect(hso).not.toHaveProperty("updatedInput")
    }
  })

  test("sequential allow calls produce independent outputs", async () => {
    const inputs = [
      { command: "echo first" },
      { command: "echo second", timeout: 100 },
      { file_path: "/tmp/third.ts" },
    ]
    const results: JsonObject[] = []
    for (const input of inputs) {
      const { parsed } = await runHelper(
        `allowPreToolUseWithUpdatedInput } from "./hook-utils.ts"; ` +
          `allowPreToolUseWithUpdatedInput(${JSON.stringify(input)})`
      )
      results.push(parsed)
    }
    for (const [i, result] of results.entries()) {
      const hso = result.hookSpecificOutput as JsonObject
      expect(hso.permissionDecision).toBe("allow")
      expect(hso.updatedInput).toEqual(inputs[i])
    }
  })

  test("deny followed by allow produces clean allow (no deny residue)", async () => {
    const { parsed: denyResult } = await runHelper(
      `denyPreToolUse } from "./hook-utils.ts"; denyPreToolUse("blocked")`
    )
    const denyHso = denyResult.hookSpecificOutput as JsonObject
    expect(denyHso.permissionDecision).toBe("deny")

    const { parsed: allowResult } = await runHelper(
      `allowPreToolUseWithUpdatedInput } from "./hook-utils.ts"; ` +
        `allowPreToolUseWithUpdatedInput({ command: "echo clean" })`
    )
    const allowHso = allowResult.hookSpecificOutput as JsonObject
    expect(allowHso.permissionDecision).toBe("allow")
    expect(allowHso.updatedInput).toEqual({ command: "echo clean" })
    expect(allowHso).not.toHaveProperty("permissionDecisionReason")
  })

  test("allow followed by deny produces clean deny (no allow residue)", async () => {
    const { parsed: allowResult } = await runHelper(
      `allowPreToolUseWithUpdatedInput } from "./hook-utils.ts"; ` +
        `allowPreToolUseWithUpdatedInput({ command: "echo first" }, "rewritten")`
    )
    const allowHso = allowResult.hookSpecificOutput as JsonObject
    expect(allowHso.permissionDecision).toBe("allow")
    expect(allowHso.updatedInput).toEqual({ command: "echo first" })

    const { parsed: denyResult } = await runHelper(
      `denyPreToolUse } from "./hook-utils.ts"; denyPreToolUse("now blocked")`
    )
    const denyHso = denyResult.hookSpecificOutput as JsonObject
    expect(denyHso.permissionDecision).toBe("deny")
    expect(denyHso.permissionDecisionReason as string).toStartWith("now blocked")
    expect(denyHso).not.toHaveProperty("updatedInput")
  })

  test("concurrent invocations are fully isolated", async () => {
    const [denyA, allowB, denyC] = await Promise.all([
      runHelper(`denyPreToolUse } from "./hook-utils.ts"; denyPreToolUse("concurrent-deny-A")`),
      runHelper(
        `allowPreToolUseWithUpdatedInput } from "./hook-utils.ts"; ` +
          `allowPreToolUseWithUpdatedInput({ concurrent: "B" })`
      ),
      runHelper(`denyPreToolUse } from "./hook-utils.ts"; denyPreToolUse("concurrent-deny-C")`),
    ])

    const hsoA = denyA.parsed.hookSpecificOutput as JsonObject
    expect(hsoA.permissionDecision).toBe("deny")
    expect(hsoA.permissionDecisionReason as string).toStartWith("concurrent-deny-A")
    expect(hsoA).not.toHaveProperty("updatedInput")

    const hsoB = allowB.parsed.hookSpecificOutput as JsonObject
    expect(hsoB.permissionDecision).toBe("allow")
    expect(hsoB.updatedInput).toEqual({ concurrent: "B" })

    const hsoC = denyC.parsed.hookSpecificOutput as JsonObject
    expect(hsoC.permissionDecision).toBe("deny")
    expect(hsoC.permissionDecisionReason as string).toStartWith("concurrent-deny-C")
    expect(hsoC).not.toHaveProperty("updatedInput")
  })

  test("same helper called twice with different inputs yields distinct outputs", async () => {
    const { parsed: first } = await runHelper(
      `allowPreToolUseWithUpdatedInput } from "./hook-utils.ts"; ` +
        `allowPreToolUseWithUpdatedInput({ version: 1 }, "first call")`
    )
    const { parsed: second } = await runHelper(
      `allowPreToolUseWithUpdatedInput } from "./hook-utils.ts"; ` +
        `allowPreToolUseWithUpdatedInput({ version: 2 }, "second call")`
    )

    const hso1 = first.hookSpecificOutput as JsonObject
    const hso2 = second.hookSpecificOutput as JsonObject

    expect(hso1.updatedInput).toEqual({ version: 1 })
    expect(hso1.permissionDecisionReason).toBe("first call")

    expect(hso2.updatedInput).toEqual({ version: 2 })
    expect(hso2.permissionDecisionReason).toBe("second call")

    expect(hso1.updatedInput).not.toEqual(hso2.updatedInput)
    expect(hso1.permissionDecisionReason).not.toBe(hso2.permissionDecisionReason)
  })
})

describe("blockStop", () => {
  test("includes a cause summary in the stop footer", async () => {
    const { exitCode, parsed } = await runHelper(
      `blockStop } from "./hook-utils.ts"; blockStop("STOP. Tasks have gone stale after 20 tool calls.")`
    )
    expect(exitCode).toBe(0)
    expect(parsed.decision).toBe("block")
    const reason = parsed.reason as string
    expect(reason).toContain("Cause to capture:")
    expect(reason).toContain("A hook detected missing or unstructured workflow behavior")
    expect(reason).toContain("Tasks have gone stale after 20 tool calls.")
  })
})
