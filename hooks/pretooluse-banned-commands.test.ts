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

    test("bun test --reporter=verbose is blocked with corrected command", async () => {
      const result = await runHook("bun test hooks/foo.test.ts --reporter=verbose")
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("'verbose' is not valid")
      expect(result.reason).toContain("bun test hooks/foo.test.ts --reporter=dots")
    })

    test("bun test --reporter verbose (space form) is blocked", async () => {
      const result = await runHook("bun test hooks/foo.test.ts --reporter verbose")
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("'verbose' is not valid")
      expect(result.reason).toContain("--reporter=dots")
    })

    test("bun test --reporter='verbose' (quoted equals form) is blocked", async () => {
      const result = await runHook("bun test foo.ts --reporter='verbose'")
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("'verbose' is not valid")
      expect(result.reason).toContain("--reporter=dots")
    })

    test("chained: second invocation with bad reporter is blocked", async () => {
      const result = await runHook(
        "bun test a.test.ts --reporter=dots && bun test b.test.ts --reporter=verbose"
      )
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("'verbose' is not valid")
      // Both occurrences replaced in the corrected command
      expect(result.reason).toContain("b.test.ts --reporter=dots")
    })

    test('bun test --reporter="verbose" (double-quoted) is blocked', async () => {
      const result = await runHook('bun test foo.ts --reporter="verbose"')
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("'verbose' is not valid")
      expect(result.reason).toContain("--reporter=dots")
    })

    test("bun test --reporter=\\'verbose\\' (escaped single-quote) is blocked", async () => {
      const result = await runHook("bun test foo.ts --reporter=\\'verbose\\'")
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("'verbose' is not valid")
      expect(result.reason).toContain("--reporter=dots")
    })

    test("-r verbose (short alias, space form) is blocked", async () => {
      const result = await runHook("bun test foo.ts -r verbose")
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("'verbose' is not valid")
      expect(result.reason).toContain("--reporter=dots")
    })

    test("-r=verbose (short alias, equals form) is blocked", async () => {
      const result = await runHook("bun test foo.ts -r=verbose")
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("'verbose' is not valid")
      expect(result.reason).toContain("--reporter=dots")
    })

    test("bun test --reporter=pretty is blocked with corrected command", async () => {
      const result = await runHook("bun test --reporter=pretty src/")
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("'pretty' is not valid")
      expect(result.reason).toContain("--reporter=dots")
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

    test("bun test --reporter=dots passes through", async () => {
      const result = await runHook("bun test hooks/foo.test.ts --reporter=dots")
      expect(result.decision).toBeUndefined()
    })

    test("bun test --reporter dots (space form) passes through", async () => {
      const result = await runHook("bun test hooks/foo.test.ts --reporter dots")
      expect(result.decision).toBeUndefined()
    })

    test("-r dots (short alias) passes through", async () => {
      const result = await runHook("bun test hooks/foo.test.ts -r dots")
      expect(result.decision).toBeUndefined()
    })

    test("-r=junit (short alias) passes through", async () => {
      const result = await runHook("bun test hooks/foo.test.ts -r=junit")
      expect(result.decision).toBeUndefined()
    })

    test("bun test --reporter=junit passes through", async () => {
      const result = await runHook("bun test hooks/foo.test.ts --reporter=junit")
      expect(result.decision).toBeUndefined()
    })

    test("chained: both invocations with valid reporters pass through", async () => {
      const result = await runHook(
        "bun test a.test.ts --reporter=dots && bun test b.test.ts --reporter=junit"
      )
      expect(result.decision).toBeUndefined()
    })

    test("echo with bun test --reporter=verbose in JSON payload is not blocked", async () => {
      // The reporter check must not fire when bun test appears inside a quoted
      // string that is an argument to echo (e.g. piping JSON to a hook script).
      const cmd = `echo '{"tool_input":{"command":"bun test foo.ts --reporter=verbose"}}' | bun hooks/pretooluse-banned-commands.ts`
      const result = await runHook(cmd)
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
