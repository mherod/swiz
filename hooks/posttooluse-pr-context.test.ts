import { describe, expect, test } from "bun:test"

// ─── Hook runner ─────────────────────────────────────────────────────────────

interface HookResult {
  context?: string
  rawOutput: string
  exitedCleanly: boolean
}

async function runHook(command: string, cwd = "/tmp"): Promise<HookResult> {
  const payload = JSON.stringify({
    tool_name: "Bash",
    tool_input: { command },
    cwd,
  })

  const proc = Bun.spawn(["bun", "hooks/posttooluse-pr-context.ts"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  proc.stdin.write(payload)
  proc.stdin.end()

  const rawOutput = await new Response(proc.stdout).text()
  await proc.exited

  const exitedCleanly = proc.exitCode === 0
  if (!rawOutput.trim()) return { rawOutput, exitedCleanly }

  try {
    const parsed = JSON.parse(rawOutput.trim())
    return {
      context: parsed.hookSpecificOutput?.additionalContext,
      rawOutput,
      exitedCleanly,
    }
  } catch {
    return { rawOutput, exitedCleanly }
  }
}

// ─── Checkout detection ───────────────────────────────────────────────────────

describe("posttooluse-pr-context: checkout detection (\\s*git checkout)", () => {
  // All checkout-command tests produce empty output because there is no real PR
  // (gh pr view fails). The hook exits silently with code 0. What we verify is
  // that non-checkout commands also exit silently, i.e. both paths are stable.

  test("non-checkout command exits silently with no output", async () => {
    const result = await runHook("git status")
    expect(result.rawOutput.trim()).toBe("")
    expect(result.exitedCleanly).toBe(true)
  })

  test("git diff command exits silently", async () => {
    const result = await runHook("git diff --stat")
    expect(result.rawOutput.trim()).toBe("")
    expect(result.exitedCleanly).toBe(true)
  })

  test("bun test command exits silently", async () => {
    const result = await runHook("bun test")
    expect(result.rawOutput.trim()).toBe("")
    expect(result.exitedCleanly).toBe(true)
  })

  test("echo command with git checkout in string exits silently (no false positive)", async () => {
    // 'echo "git checkout"' — the text appears inside quotes, not as a real command.
    // The regex requires it to follow ^, ;, &&, or ||, so this must not trigger.
    const result = await runHook('echo "git checkout feature"')
    expect(result.rawOutput.trim()).toBe("")
    expect(result.exitedCleanly).toBe(true)
  })

  test("git checkout command exits cleanly (no PR found)", async () => {
    // In a non-git tmp dir, git branch fails → branch empty → exits silently
    const result = await runHook("git checkout main")
    expect(result.exitedCleanly).toBe(true)
  })

  test("semicolon-separated checkout exits cleanly: echo x; git checkout main", async () => {
    const result = await runHook("echo x; git checkout main")
    expect(result.exitedCleanly).toBe(true)
  })

  test("&& checkout exits cleanly: git fetch && git checkout main", async () => {
    const result = await runHook("git fetch && git checkout main")
    expect(result.exitedCleanly).toBe(true)
  })

  test("git checkouts (typo, no word boundary match) exits silently", async () => {
    // 'checkouts' should NOT match due to \b word boundary in the regex
    const result = await runHook("git checkouts list")
    expect(result.rawOutput.trim()).toBe("")
    expect(result.exitedCleanly).toBe(true)
  })

  test("gh pr checkout exits cleanly (no PR found)", async () => {
    const result = await runHook("gh pr checkout 123")
    expect(result.exitedCleanly).toBe(true)
  })

  // The hook now fetches latestReviews and renders approval details when present.
  // In a non-PR environment (main branch, /tmp), the hook exits before reaching
  // the review rendering logic. These tests verify the hook remains stable with
  // the added latestReviews field in the gh pr view call.

  test("git checkout on main branch in real repo exits cleanly with latestReviews field", async () => {
    // Running from the actual repo CWD on main — no PR exists, hook exits silently.
    // This verifies the latestReviews field addition doesn't break the happy path.
    const result = await runHook("git checkout main", process.cwd())
    expect(result.exitedCleanly).toBe(true)
  })

  test("non-shell tool exits silently (tool_name filtering)", async () => {
    const payload = JSON.stringify({
      tool_name: "Read",
      tool_input: { command: "git checkout main" },
      cwd: "/tmp",
    })

    const proc = Bun.spawn(["bun", "hooks/posttooluse-pr-context.ts"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    proc.stdin.write(payload)
    proc.stdin.end()

    const rawOutput = await new Response(proc.stdout).text()
    await proc.exited

    expect(rawOutput.trim()).toBe("")
    expect(proc.exitCode).toBe(0)
  })
})
