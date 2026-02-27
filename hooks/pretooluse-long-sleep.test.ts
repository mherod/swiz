import { describe, expect, test } from "bun:test"

async function runHook(command: string): Promise<{ decision?: string; reason?: string }> {
  const payload = JSON.stringify({
    tool_name: "Bash",
    tool_input: { command },
  })
  const proc = Bun.spawn(["bun", "hooks/pretooluse-long-sleep.ts"], {
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
  }
}

describe("pretooluse-long-sleep", () => {
  describe("blocked (>= 30s)", () => {
    test("sleep 30 is denied", async () => {
      const result = await runHook("sleep 30")
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("sleep 30")
    })

    test("sleep 60 is denied", async () => {
      const result = await runHook("sleep 60")
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("sleep 60")
    })

    test("sleep 300 is denied", async () => {
      const result = await runHook("sleep 300")
      expect(result.decision).toBe("deny")
    })

    test("reason includes alternative patterns", async () => {
      const result = await runHook("sleep 30")
      expect(result.reason).toContain("Poll with timeout")
    })
  })

  describe("allowed (< 30s)", () => {
    test("sleep 29 is allowed", async () => {
      const result = await runHook("sleep 29")
      expect(result.decision).toBe("allow")
    })

    test("sleep 5 is allowed", async () => {
      const result = await runHook("sleep 5")
      expect(result.decision).toBe("allow")
    })

    test("sleep 0 is allowed", async () => {
      const result = await runHook("sleep 0")
      expect(result.decision).toBe("allow")
    })

    test("sleep 1 is allowed", async () => {
      const result = await runHook("sleep 1")
      expect(result.decision).toBe("allow")
    })
  })

  describe("non-sleep commands", () => {
    test("git status is allowed", async () => {
      const result = await runHook("git status")
      expect(result.decision).toBe("allow")
    })

    test("bun test is allowed", async () => {
      const result = await runHook("bun test")
      expect(result.decision).toBe("allow")
    })

    test("poll loop with short inner sleep is allowed", async () => {
      const result = await runHook(
        "timeout 120 bash -c 'while ! curl -s localhost:3000; do sleep 2; done'"
      )
      expect(result.decision).toBe("allow")
    })
  })
})
