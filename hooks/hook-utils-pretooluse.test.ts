import { describe, expect, test } from "bun:test"

type JsonObject = Record<string, unknown>

/**
 * Run an inline bun script that imports and calls a hook-utils helper.
 * This avoids mocking process.exit — the helper runs in a real subprocess.
 */
async function runHelper(code: string): Promise<{
  exitCode: number | null
  parsed: JsonObject
}> {
  const script = `import { ${code}`
  const proc = Bun.spawn(["bun", "-e", script], {
    stdout: "pipe",
    stderr: "pipe",
    cwd: import.meta.dir,
  })
  const stdout = await new Response(proc.stdout).text()
  await proc.exited
  return {
    exitCode: proc.exitCode,
    parsed: JSON.parse(stdout.trim()) as JsonObject,
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
