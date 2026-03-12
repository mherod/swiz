import { describe, expect, test } from "bun:test"

// ─── Hook runner ─────────────────────────────────────────────────────────────

interface HookResult {
  denied: boolean
  reason?: string
  rawOutput: string
  exitedCleanly: boolean
}

async function runHook(command: string, cwd = "/tmp"): Promise<HookResult> {
  const payload = JSON.stringify({
    tool_name: "Bash",
    tool_input: { command },
    cwd,
  })

  const proc = Bun.spawn(["bun", "hooks/pretooluse-stale-approval-gate.ts"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  void proc.stdin.write(payload)
  void proc.stdin.end()

  const rawOutput = await new Response(proc.stdout).text()
  await proc.exited

  const exitedCleanly = proc.exitCode === 0
  if (!rawOutput.trim()) return { denied: false, rawOutput, exitedCleanly }

  try {
    const parsed = JSON.parse(rawOutput.trim())
    const decision = parsed.hookSpecificOutput?.permissionDecision
    const reason = parsed.hookSpecificOutput?.permissionDecisionReason
    return {
      denied: decision === "deny",
      reason,
      rawOutput,
      exitedCleanly,
    }
  } catch {
    return { denied: false, rawOutput, exitedCleanly }
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("pretooluse-stale-approval-gate", () => {
  describe("non-commit commands are allowed", () => {
    test("git status passes through", async () => {
      const result = await runHook("git status")
      expect(result.denied).toBe(false)
      expect(result.exitedCleanly).toBe(true)
    })

    test("git push passes through", async () => {
      const result = await runHook("git push origin main")
      expect(result.denied).toBe(false)
      expect(result.exitedCleanly).toBe(true)
    })

    test("git diff passes through", async () => {
      const result = await runHook("git diff --stat")
      expect(result.denied).toBe(false)
      expect(result.exitedCleanly).toBe(true)
    })

    test("bun test passes through", async () => {
      const result = await runHook("bun test")
      expect(result.denied).toBe(false)
      expect(result.exitedCleanly).toBe(true)
    })
  })

  describe("git commit on default branch is allowed", () => {
    // On default branch, the hook exits early (isDefaultBranch check).
    // In /tmp there's no git repo, so it exits even earlier (isGitRepo check).
    test("git commit in non-git dir exits cleanly", async () => {
      const result = await runHook('git commit -m "test"')
      expect(result.denied).toBe(false)
      expect(result.exitedCleanly).toBe(true)
    })
  })

  describe("non-shell tool is ignored", () => {
    test("Edit tool with git commit in content passes through", async () => {
      const payload = JSON.stringify({
        tool_name: "Edit",
        tool_input: { command: 'git commit -m "test"' },
        cwd: "/tmp",
      })

      const proc = Bun.spawn(["bun", "hooks/pretooluse-stale-approval-gate.ts"], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      })
      void proc.stdin.write(payload)
      void proc.stdin.end()

      const rawOutput = await new Response(proc.stdout).text()
      await proc.exited

      expect(rawOutput.trim()).toBe("")
      expect(proc.exitCode).toBe(0)
    })
  })

  describe("fail-open on missing environment", () => {
    test("empty cwd exits cleanly", async () => {
      const payload = JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: 'git commit -m "test"' },
        cwd: "",
      })

      const proc = Bun.spawn(["bun", "hooks/pretooluse-stale-approval-gate.ts"], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      })
      void proc.stdin.write(payload)
      void proc.stdin.end()

      const rawOutput = await new Response(proc.stdout).text()
      await proc.exited

      expect(rawOutput.trim()).toBe("")
      expect(proc.exitCode).toBe(0)
    })

    test("non-git directory exits cleanly", async () => {
      const result = await runHook('git commit -m "test"', "/tmp")
      expect(result.denied).toBe(false)
      expect(result.exitedCleanly).toBe(true)
    })
  })
})
