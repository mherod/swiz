import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"

const HOOK_PATH = resolve(process.cwd(), "hooks/pretooluse-no-mixed-tool-calls.ts")

async function runHook(
  command: string,
  opts: { toolName?: string } = {}
): Promise<{ decision?: string; reason?: string; stdout: string }> {
  const payload = JSON.stringify({
    tool_name: opts.toolName ?? "Bash",
    tool_input: { command },
  })
  const proc = Bun.spawn(["bun", HOOK_PATH], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  void proc.stdin.write(payload)
  void proc.stdin.end()
  const out = await new Response(proc.stdout).text()
  await proc.exited

  const stdout = out.trim()
  if (!stdout) return { stdout }

  const parsed = JSON.parse(stdout)
  const hso = parsed.hookSpecificOutput
  return {
    decision: hso?.permissionDecision ?? parsed.decision,
    reason: hso?.permissionDecisionReason ?? parsed.reason,
    stdout,
  }
}

describe("pretooluse-no-mixed-tool-calls", () => {
  test("blocks a Bash command that starts with TaskCreate", async () => {
    const result = await runHook(
      "TaskCreate 2>/dev/null; swiz tasks 2>/dev/null | head -20 || true"
    )
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("TaskCreate")
    expect(result.reason).toContain("not a terminal command")
    expect(result.reason).toContain("swiz tasks")
  })

  test("blocks nested Bash(...) shell tool syntax", async () => {
    const result = await runHook("Bash(git status)")
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("Bash")
    expect(result.reason).toContain("Do not nest")
  })

  test("blocks Read used as a shell command", async () => {
    const result = await runHook("Read src/index.ts")
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("Read")
    expect(result.reason).toContain("tool interface")
  })

  test("blocks agent alias after env assignments", async () => {
    const result = await runHook("DEBUG=1 update_plan")
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("update_plan")
  })

  test("allows normal shell commands", async () => {
    const result = await runHook("swiz tasks 2>/dev/null | head -20 || true")
    expect(result.stdout).toBe("")
  })

  test("does not trigger on tool names used as plain arguments", async () => {
    const result = await runHook("echo TaskCreate")
    expect(result.stdout).toBe("")
  })

  test("ignores non-shell tools", async () => {
    const result = await runHook("TaskCreate", { toolName: "Read" })
    expect(result.stdout).toBe("")
  })
})
