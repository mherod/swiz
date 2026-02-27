import { describe, expect, test } from "bun:test"

// Test the hook by piping JSON to the script and checking output

async function runHook(
  command: string
): Promise<{ decision?: string; allow?: boolean; reason?: string }> {
  const payload = JSON.stringify({
    tool_name: "Bash",
    tool_input: { command },
  })
  const proc = Bun.spawn(["bun", "hooks/pretooluse-banned-commands.ts"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  proc.stdin.write(payload)
  proc.stdin.end()
  const out = await new Response(proc.stdout).text()
  await proc.exited

  if (!out.trim()) return {}
  const parsed = JSON.parse(out.trim())
  const hso = parsed.hookSpecificOutput
  return {
    decision: hso?.permissionDecision ?? parsed.decision,
    reason: hso?.permissionDecisionReason ?? parsed.reason,
    allow: hso?.permissionDecision === "allow",
  }
}

describe("pretooluse-banned-commands", () => {
  describe("warn severity (allow with hint)", () => {
    test("grep gets a gentle nudge", async () => {
      const result = await runHook("grep -r TODO src/")
      expect(result.decision).toBe("allow")
      expect(result.reason).toContain("rg")
    })

    test("find gets a gentle nudge", async () => {
      const result = await runHook("find . -name '*.ts'")
      expect(result.decision).toBe("allow")
      expect(result.reason).toContain("fd")
    })
  })

  describe("deny severity (blocked)", () => {
    test("sed is blocked", async () => {
      const result = await runHook("sed -i 's/foo/bar/' file.ts")
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("Edit tool")
    })

    test("awk is blocked", async () => {
      const result = await runHook("awk '{print $1}' file.ts")
      expect(result.decision).toBe("deny")
    })

    test("rm is blocked", async () => {
      const result = await runHook("rm -rf node_modules")
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("trash")
    })

    test("cd is blocked", async () => {
      const result = await runHook("cd /tmp && ls")
      expect(result.decision).toBe("deny")
    })

    test("touch is blocked", async () => {
      const result = await runHook("touch newfile.ts")
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("Write tool")
    })

    test("python is blocked", async () => {
      const result = await runHook("python3 script.py")
      expect(result.decision).toBe("deny")
    })

    test("git stash is blocked", async () => {
      const result = await runHook("git stash")
      expect(result.decision).toBe("deny")
    })

    test("git reset --hard is blocked", async () => {
      const result = await runHook("git reset --hard HEAD~1")
      expect(result.decision).toBe("deny")
    })

    test("git commit --no-verify is blocked", async () => {
      const result = await runHook("git commit --no-verify -m 'test'")
      expect(result.decision).toBe("deny")
    })

    test("--trailer is blocked", async () => {
      const result = await runHook("git commit --trailer 'Co-authored-by: AI'")
      expect(result.decision).toBe("deny")
    })
  })

  describe("allowed commands (no output)", () => {
    test("git status passes through", async () => {
      const result = await runHook("git status")
      expect(result.decision).toBeUndefined()
    })

    test("echo passes through", async () => {
      const result = await runHook("echo hello")
      expect(result.decision).toBeUndefined()
    })

    test("bun test passes through", async () => {
      const result = await runHook("bun test")
      expect(result.decision).toBeUndefined()
    })

    test("rg passes through", async () => {
      const result = await runHook("rg 'pattern' src/")
      expect(result.decision).toBeUndefined()
    })
  })

  describe("non-Bash tools are ignored", () => {
    test("Edit tool exits silently", async () => {
      const payload = JSON.stringify({ tool_name: "Edit", tool_input: { command: "rm -rf /" } })
      const proc = Bun.spawn(["bun", "hooks/pretooluse-banned-commands.ts"], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      })
      proc.stdin.write(payload)
      proc.stdin.end()
      const out = await new Response(proc.stdout).text()
      await proc.exited
      expect(out.trim()).toBe("")
      expect(proc.exitCode).toBe(0)
    })
  })
})
