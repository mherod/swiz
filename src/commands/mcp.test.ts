import { describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { appendReplyToSink, evaluatePermissionPolicy, loadPermissionPolicy } from "./mcp.ts"

async function writeRawPolicy(cwd: string, content: string): Promise<string> {
  const policyPath = join(cwd, ".swiz", "permission-policy.json")
  await mkdir(dirname(policyPath), { recursive: true })
  await writeFile(policyPath, content)
  return policyPath
}

async function writePolicy(cwd: string, rules: unknown[]): Promise<string> {
  return writeRawPolicy(cwd, JSON.stringify({ rules }))
}

function captureStderr<T>(fn: () => T): { result: T; stderr: string } {
  const originalWrite = process.stderr.write
  let stderr = ""
  process.stderr.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
    stderr += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk)
    const callback = args.find(
      (arg): arg is (error?: Error | null) => void => typeof arg === "function"
    )
    callback?.()
    return true
  }) as typeof process.stderr.write
  try {
    return { result: fn(), stderr }
  } finally {
    process.stderr.write = originalWrite
  }
}

describe("loadPermissionPolicy", () => {
  it("treats a missing policy file as an empty policy without noise", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "swiz-mcp-test-"))

    const { result: rules, stderr } = captureStderr(() => loadPermissionPolicy(cwd))

    expect(rules).toEqual([])
    expect(stderr).toBe("")
    expect(stderr).not.toContain("permission-policy.json unavailable")
  })

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
    const policyPath = await writePolicy(cwd, [
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

    const { result: rules, stderr } = captureStderr(() => loadPermissionPolicy(cwd))

    expect(rules).toHaveLength(1)
    expect(rules[0]?.tool).toBe("read_file")
    expect(rules[0]?.pattern).toBe("safe-read")
    expect(evaluatePermissionPolicy(rules, "read_file", "safe-read")).toBe("allow")
    expect(stderr).toContain(
      `swiz mcp: permission-policy.json at ${policyPath} skipped unsafe pattern "(a+)+"`
    )
    expect(stderr).toContain("unsupported constructs were rejected")
  })

  it("keeps file valid when one rule has invalid regex syntax", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "swiz-mcp-test-"))
    const policyPath = await writePolicy(cwd, [
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

    const { result: rules, stderr } = captureStderr(() => loadPermissionPolicy(cwd))

    expect(rules).toHaveLength(1)
    expect(rules[0]?.tool).toBe("grep")
    expect(rules[0]?.pattern).toBe("safe")
    expect(stderr).toContain(
      `swiz mcp: permission-policy.json at ${policyPath} skipped unsafe pattern "(unclosed"`
    )
    expect(stderr).toContain("Invalid regular expression")
  })

  it("reports malformed JSON with the policy path and parse reason", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "swiz-mcp-test-"))
    const policyPath = await writeRawPolicy(cwd, "")

    const { result: rules, stderr } = captureStderr(() => loadPermissionPolicy(cwd))

    expect(rules).toEqual([])
    expect(stderr).toContain(`failed to parse permission-policy.json at ${policyPath}`)
    expect(stderr).toContain("Unexpected")
  })

  it("reports schema-invalid rules with the policy path and validation reason", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "swiz-mcp-test-"))
    const policyPath = await writeRawPolicy(
      cwd,
      JSON.stringify({ rules: [{ tool: "read_file", behavior: "maybe" }] })
    )

    const { result: rules, stderr } = captureStderr(() => loadPermissionPolicy(cwd))

    expect(rules).toEqual([])
    expect(stderr).toContain(`permission-policy.json schema invalid at ${policyPath}`)
    expect(stderr).toContain("behavior")
  })

  it("reports policy I/O failures with the policy path and failure reason", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "swiz-mcp-test-"))
    const policyPath = join(cwd, ".swiz", "permission-policy.json")
    await mkdir(policyPath, { recursive: true })

    const { result: rules, stderr } = captureStderr(() => loadPermissionPolicy(cwd))

    expect(rules).toEqual([])
    expect(stderr).toContain(`permission-policy.json unavailable at ${policyPath}`)
    expect(stderr).toMatch(/EISDIR|is a directory|illegal operation/i)
  })
})

describe("appendReplyToSink", () => {
  it("writes a JSONL line to the replies log", async () => {
    const home = await mkdtemp(join(tmpdir(), "swiz-mcp-reply-test-"))
    await appendReplyToSink("/some/project", { content: "hello", kind: "note" }, home)
    const logPath = join(home, ".swiz", "mcp-replies.jsonl")
    const raw = await readFile(logPath, "utf8")
    const line = JSON.parse(raw.trim())
    expect(line.content).toBe("hello")
    expect(line.kind).toBe("note")
    expect(line.cwd).toBe("/some/project")
    expect(typeof line.ts).toBe("number")
  })

  it("appends multiple writes in order", async () => {
    const home = await mkdtemp(join(tmpdir(), "swiz-mcp-reply-order-"))
    await appendReplyToSink("/proj", { content: "first", kind: "note" }, home)
    await appendReplyToSink("/proj", { content: "second", kind: "note" }, home)
    const logPath = join(home, ".swiz", "mcp-replies.jsonl")
    const lines = (await readFile(logPath, "utf8")).trim().split("\n")
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]!).content).toBe("first")
    expect(JSON.parse(lines[1]!).content).toBe("second")
  })

  it("rejects when the log path is an existing directory", async () => {
    const home = await mkdtemp(join(tmpdir(), "swiz-mcp-reply-fail-"))
    // Occupy the log path with a directory so appendFile fails.
    await mkdir(join(home, ".swiz", "mcp-replies.jsonl"), { recursive: true })
    let threw = false
    try {
      await appendReplyToSink("/proj", { content: "x", kind: "note" }, home)
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  })
})
