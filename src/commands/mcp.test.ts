import { describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { evaluatePermissionPolicy, loadPermissionPolicy } from "./mcp.ts"

async function writePolicy(cwd: string, rules: unknown[]): Promise<void> {
  const policyPath = join(cwd, ".swiz", "permission-policy.json")
  await mkdir(dirname(policyPath), { recursive: true })
  await writeFile(policyPath, JSON.stringify({ rules }))
}

describe("loadPermissionPolicy", () => {
  it("loads and compiles safe patterns once per rule", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "swiz-mcp-test-"))
    await writePolicy(cwd, [
      {
        tool: "*",
        pattern: "allow-test",
        behavior: "allow",
      },
      {
        tool: "write_file",
        behavior: "deny",
      },
    ])

    const rules = loadPermissionPolicy(cwd)

    expect(rules).toHaveLength(2)
    expect(rules[0]?.patternRegex).toBeInstanceOf(RegExp)
    expect(rules[0]?.pattern).toBe("allow-test")
    expect(evaluatePermissionPolicy(rules, "anything", "this is an allow-test message")).toBe(
      "allow"
    )
    expect(evaluatePermissionPolicy(rules, "write_file", "any input")).toBe("deny")
  })

  it("skips unsafe regex patterns and keeps the rest", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "swiz-mcp-test-"))
    await writePolicy(cwd, [
      {
        tool: "*",
        pattern: "(a+)+",
        behavior: "deny",
      },
      {
        tool: "read_file",
        pattern: "safe-read",
        behavior: "allow",
      },
    ])

    const rules = loadPermissionPolicy(cwd)

    expect(rules).toHaveLength(1)
    expect(rules[0]?.tool).toBe("read_file")
    expect(rules[0]?.pattern).toBe("safe-read")
    expect(evaluatePermissionPolicy(rules, "read_file", "safe-read")).toBe("allow")
  })

  it("keeps file valid when one rule has invalid regex syntax", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "swiz-mcp-test-"))
    await writePolicy(cwd, [
      {
        tool: "edit",
        pattern: "(unclosed",
        behavior: "deny",
      },
      {
        tool: "grep",
        pattern: "safe",
        behavior: "allow",
      },
    ])

    const rules = loadPermissionPolicy(cwd)

    expect(rules).toHaveLength(1)
    expect(rules[0]?.tool).toBe("grep")
    expect(rules[0]?.pattern).toBe("safe")
  })
})
