import { describe, expect, test } from "bun:test"
import { runHook as runHookScript } from "../src/utils/test-utils.ts"

async function runChangesContextHook(command: string, cwd = "/tmp") {
  const result = await runHookScript("hooks/posttooluse-pr-changes-context.ts", {
    tool_name: "Bash",
    tool_input: { command },
    cwd,
  })
  const hookSpecificOutput = result.json?.hookSpecificOutput as Record<string, any> | undefined
  return {
    context:
      typeof hookSpecificOutput?.additionalContext === "string"
        ? hookSpecificOutput.additionalContext
        : undefined,
    exitedCleanly: result.exitCode === 0,
  }
}

describe("posttooluse-pr-changes-context: non-checkout commands", () => {
  test("git status exits silently", async () => {
    const result = await runChangesContextHook("git status")
    expect(result.context).toBeUndefined()
    expect(result.exitedCleanly).toBe(true)
  })

  test("git commit exits silently", async () => {
    const result = await runChangesContextHook('git commit -m "fix"')
    expect(result.context).toBeUndefined()
    expect(result.exitedCleanly).toBe(true)
  })

  test("git push exits silently", async () => {
    const result = await runChangesContextHook("git push origin main")
    expect(result.context).toBeUndefined()
    expect(result.exitedCleanly).toBe(true)
  })

  test("bun test exits silently", async () => {
    const result = await runChangesContextHook("bun test")
    expect(result.context).toBeUndefined()
    expect(result.exitedCleanly).toBe(true)
  })
})

describe("posttooluse-pr-changes-context: checkout commands (no PR environment)", () => {
  test("git checkout exits cleanly with no output when not in git repo", async () => {
    const result = await runChangesContextHook("git checkout feature-branch")
    expect(result.exitedCleanly).toBe(true)
    expect(result.context).toBeUndefined()
  })

  test("git switch exits cleanly with no output when not in git repo", async () => {
    const result = await runChangesContextHook("git switch feature-branch")
    expect(result.exitedCleanly).toBe(true)
    expect(result.context).toBeUndefined()
  })

  test("gh pr checkout exits cleanly with no output when not in git repo", async () => {
    const result = await runChangesContextHook("gh pr checkout 123")
    expect(result.exitedCleanly).toBe(true)
    expect(result.context).toBeUndefined()
  })

  test("git checkout main in real repo exits cleanly (no PR on default branch)", async () => {
    const result = await runChangesContextHook("git checkout main", process.cwd())
    expect(result.exitedCleanly).toBe(true)
    expect(result.context).toBeUndefined()
  })

  test("semicolon-chained checkout exits cleanly", async () => {
    const result = await runChangesContextHook("git fetch && git checkout feature-branch")
    expect(result.exitedCleanly).toBe(true)
  })
})

describe("posttooluse-pr-changes-context: tool filtering", () => {
  test("non-shell tool exits silently", async () => {
    const payload = JSON.stringify({
      tool_name: "Read",
      tool_input: { command: "git checkout feature-branch" },
      cwd: "/tmp",
    })

    const proc = Bun.spawn(["bun", "hooks/posttooluse-pr-changes-context.ts"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    await proc.stdin.write(payload)
    await proc.stdin.end()

    const rawOutput = await new Response(proc.stdout).text()
    await proc.exited

    expect(rawOutput.trim()).toBe("")
    expect(proc.exitCode).toBe(0)
  })
})
