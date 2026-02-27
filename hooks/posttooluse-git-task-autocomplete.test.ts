import { describe, expect, test } from "bun:test"

// ─── Hook runner ─────────────────────────────────────────────────────────────

interface HookResult {
  additionalContext?: string
  rawOutput: string
  exitedCleanly: boolean
}

async function runHook(
  command: string,
  toolName = "Bash",
  sessionId = "test-session-id"
): Promise<HookResult> {
  const payload = JSON.stringify({
    tool_name: toolName,
    tool_input: { command },
    cwd: "/tmp",
    session_id: sessionId,
  })

  const proc = Bun.spawn(["bun", "hooks/posttooluse-git-task-autocomplete.ts"], {
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
      additionalContext: parsed.hookSpecificOutput?.additionalContext,
      rawOutput,
      exitedCleanly,
    }
  } catch {
    return { rawOutput, exitedCleanly }
  }
}

// ─── git push → additionalContext ────────────────────────────────────────────

describe("posttooluse-git-task-autocomplete: git push emits additionalContext", () => {
  test("git push emits additionalContext with CI task instruction", async () => {
    const result = await runHook("git push origin main")
    expect(result.exitedCleanly).toBe(true)
    expect(result.additionalContext).toBeDefined()
    expect(result.additionalContext).toContain("Wait for CI")
    expect(result.additionalContext).toContain("TaskCreate")
  })

  test("git push with upstream flags emits additionalContext", async () => {
    const result = await runHook("git push -u origin main")
    expect(result.exitedCleanly).toBe(true)
    expect(result.additionalContext).toBeDefined()
    expect(result.additionalContext).toContain("Wait for CI")
  })

  test("git push in a chained command emits additionalContext", async () => {
    const result = await runHook("git add . && git commit -m 'msg' && git push origin main")
    expect(result.exitedCleanly).toBe(true)
    expect(result.additionalContext).toBeDefined()
    expect(result.additionalContext).toContain("Wait for CI")
  })

  test("additionalContext hookEventName is PostToolUse", async () => {
    const result = await runHook("git push origin main")
    expect(result.exitedCleanly).toBe(true)
    const parsed = JSON.parse(result.rawOutput.trim())
    expect(parsed.hookSpecificOutput?.hookEventName).toBe("PostToolUse")
  })
})

// ─── git commit → no output ───────────────────────────────────────────────────

describe("posttooluse-git-task-autocomplete: git commit exits silently", () => {
  test("git commit exits cleanly with no stdout", async () => {
    const result = await runHook('git commit -m "feat: something"')
    expect(result.exitedCleanly).toBe(true)
    expect(result.rawOutput.trim()).toBe("")
  })

  test("git commit --amend exits silently", async () => {
    const result = await runHook("git commit --amend --no-edit")
    expect(result.exitedCleanly).toBe(true)
    expect(result.rawOutput.trim()).toBe("")
  })
})

// ─── Non-matching commands → silent ──────────────────────────────────────────

describe("posttooluse-git-task-autocomplete: non-git commands exit silently", () => {
  test("git status exits silently", async () => {
    const result = await runHook("git status")
    expect(result.rawOutput.trim()).toBe("")
    expect(result.exitedCleanly).toBe(true)
  })

  test("bun test exits silently", async () => {
    const result = await runHook("bun test")
    expect(result.rawOutput.trim()).toBe("")
    expect(result.exitedCleanly).toBe(true)
  })

  test("echo with git push in string does not trigger (no false positive)", async () => {
    const result = await runHook('echo "git push is done"')
    expect(result.rawOutput.trim()).toBe("")
    expect(result.exitedCleanly).toBe(true)
  })
})

// ─── Escaped quotes → no false positives ─────────────────────────────────────

describe("posttooluse-git-task-autocomplete: escaped quotes do not trigger", () => {
  test("single-quoted git push in echo does not trigger", async () => {
    const result = await runHook("echo 'git push origin main'")
    expect(result.rawOutput.trim()).toBe("")
    expect(result.exitedCleanly).toBe(true)
  })

  test("printf with git push string does not trigger", async () => {
    const result = await runHook("printf '%s\\n' 'git push'")
    expect(result.rawOutput.trim()).toBe("")
    expect(result.exitedCleanly).toBe(true)
  })

  test("variable assignment containing git push does not trigger", async () => {
    // PUSH_CMD="git push origin main" — git push is a value, not a command
    const result = await runHook('PUSH_CMD="git push origin main"')
    expect(result.rawOutput.trim()).toBe("")
    expect(result.exitedCleanly).toBe(true)
  })

  test("grep for git push string does not trigger", async () => {
    const result = await runHook('grep "git push" ~/.zsh_history')
    expect(result.rawOutput.trim()).toBe("")
    expect(result.exitedCleanly).toBe(true)
  })
})

// ─── Multiline shell input ────────────────────────────────────────────────────

describe("posttooluse-git-task-autocomplete: multiline commands with newline separators", () => {
  test("git push on second line (newline separator) triggers", async () => {
    const result = await runHook("git status\ngit push origin main")
    expect(result.exitedCleanly).toBe(true)
    expect(result.additionalContext).toBeDefined()
    expect(result.additionalContext).toContain("Wait for CI")
  })

  test("git push on third line triggers", async () => {
    const result = await runHook("git add .\ngit commit -m 'fix'\ngit push origin main")
    expect(result.exitedCleanly).toBe(true)
    expect(result.additionalContext).toBeDefined()
    expect(result.additionalContext).toContain("Wait for CI")
  })

  test("git commit on second line (newline separator) auto-completes silently", async () => {
    const result = await runHook("git add .\ngit commit -m 'fix'")
    expect(result.exitedCleanly).toBe(true)
    // commit-only: no additionalContext, just silent file writes
    expect(result.rawOutput.trim()).toBe("")
  })

  test("leading newline before git push triggers", async () => {
    const result = await runHook("\ngit push origin main")
    expect(result.exitedCleanly).toBe(true)
    expect(result.additionalContext).toBeDefined()
    expect(result.additionalContext).toContain("Wait for CI")
  })
})

// ─── Mixed separators ─────────────────────────────────────────────────────────

describe("posttooluse-git-task-autocomplete: mixed separator combinations", () => {
  test("semicolon separator triggers push", async () => {
    const result = await runHook("git fetch; git push origin main")
    expect(result.exitedCleanly).toBe(true)
    expect(result.additionalContext).toContain("Wait for CI")
  })

  test("|| fallback push triggers", async () => {
    const result = await runHook("git pull || git push origin main")
    expect(result.exitedCleanly).toBe(true)
    expect(result.additionalContext).toContain("Wait for CI")
  })

  test("mixed && and ; chain with push at end triggers", async () => {
    const result = await runHook("git add . && git commit -m 'fix'; git push origin main")
    expect(result.exitedCleanly).toBe(true)
    expect(result.additionalContext).toContain("Wait for CI")
  })

  test("mixed && and newline chain with push at end triggers", async () => {
    const result = await runHook("git add . && git commit -m 'fix'\ngit push origin main")
    expect(result.exitedCleanly).toBe(true)
    expect(result.additionalContext).toContain("Wait for CI")
  })

  test("push-like word without word boundary does not trigger (no false positive)", async () => {
    // 'git pusher' — 'push' without \b should not match
    const result = await runHook("git pusher list")
    expect(result.rawOutput.trim()).toBe("")
    expect(result.exitedCleanly).toBe(true)
  })
})

// ─── Non-shell tools → silent ─────────────────────────────────────────────────

describe("posttooluse-git-task-autocomplete: non-shell tool_name exits silently", () => {
  test("Read tool with git push command exits silently", async () => {
    const result = await runHook("git push origin main", "Read")
    expect(result.rawOutput.trim()).toBe("")
    expect(result.exitedCleanly).toBe(true)
  })

  test("Edit tool exits silently", async () => {
    const result = await runHook("git push origin main", "Edit")
    expect(result.rawOutput.trim()).toBe("")
    expect(result.exitedCleanly).toBe(true)
  })
})
