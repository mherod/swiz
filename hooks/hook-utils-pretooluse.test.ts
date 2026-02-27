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
    expect(hso.permissionDecisionReason).toBe("blocked for testing")
    expect(hso).not.toHaveProperty("updatedInput")
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
    expect(hso.permissionDecisionReason).toBe("")
  })

  test("handles reason with special characters", async () => {
    const { exitCode, parsed } = await runHelper(
      `denyPreToolUse } from "./hook-utils.ts"; denyPreToolUse("Line1\\nLine2\\t\\"quoted\\"\\\\backslash")`
    )
    expect(exitCode).toBe(0)
    const hso = parsed.hookSpecificOutput as JsonObject
    expect(hso.permissionDecisionReason).toBe('Line1\nLine2\t"quoted"\\backslash')
  })

  test("handles very long reason string", async () => {
    const { exitCode, parsed } = await runHelper(
      `denyPreToolUse } from "./hook-utils.ts"; denyPreToolUse("x".repeat(10000))`
    )
    expect(exitCode).toBe(0)
    const hso = parsed.hookSpecificOutput as JsonObject
    expect((hso.permissionDecisionReason as string).length).toBe(10000)
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
