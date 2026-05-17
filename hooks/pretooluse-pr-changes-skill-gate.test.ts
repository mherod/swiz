import { describe, expect, test } from "bun:test"
import { runHook as runHookScript } from "../src/utils/test-utils.ts"

async function runHook(command: string, cwd = "/tmp") {
  const result = await runHookScript("hooks/pretooluse-pr-changes-skill-gate.ts", {
    tool_name: "Bash",
    tool_input: { command },
    cwd,
  })
  return {
    decision: result.json?.decision as string | undefined,
    reason: result.json?.reason as string | undefined,
    exitedCleanly: result.exitCode === 0,
  }
}

describe("pretooluse-pr-changes-skill-gate: exempt commands", () => {
  test("git status is allowed (not commit or push)", async () => {
    const result = await runHook("git status")
    expect(result.decision).not.toBe("block")
    expect(result.exitedCleanly).toBe(true)
  })

  test("git diff is allowed", async () => {
    const result = await runHook("git diff --stat")
    expect(result.decision).not.toBe("block")
    expect(result.exitedCleanly).toBe(true)
  })

  test("git log is allowed", async () => {
    const result = await runHook("git log --oneline -5")
    expect(result.decision).not.toBe("block")
    expect(result.exitedCleanly).toBe(true)
  })

  test("bun test is allowed", async () => {
    const result = await runHook("bun test")
    expect(result.decision).not.toBe("block")
    expect(result.exitedCleanly).toBe(true)
  })

  test("gh pr view is allowed", async () => {
    const result = await runHook("gh pr view 123 --comments")
    expect(result.decision).not.toBe("block")
    expect(result.exitedCleanly).toBe(true)
  })
})

describe("pretooluse-pr-changes-skill-gate: branch deletion exempt", () => {
  test("git push --delete is allowed (branch deletion)", async () => {
    const result = await runHook("git push origin --delete feature-branch")
    expect(result.decision).not.toBe("block")
    expect(result.exitedCleanly).toBe(true)
  })

  test("git push :branch-name is allowed (branch deletion shorthand)", async () => {
    const result = await runHook("git push origin :feature-branch")
    expect(result.decision).not.toBe("block")
    expect(result.exitedCleanly).toBe(true)
  })
})

describe("pretooluse-pr-changes-skill-gate: no-PR environment (passes through)", () => {
  test("git commit in non-git dir exits cleanly", async () => {
    const result = await runHook('git commit -m "fix: update"')
    expect(result.exitedCleanly).toBe(true)
    expect(result.decision).not.toBe("block")
  })

  test("git push in non-git dir exits cleanly", async () => {
    const result = await runHook("git push origin main")
    expect(result.exitedCleanly).toBe(true)
    expect(result.decision).not.toBe("block")
  })

  test("git commit in real repo on main exits cleanly (no PR on default branch)", async () => {
    const result = await runHook('git commit -m "fix: update"', process.cwd())
    expect(result.exitedCleanly).toBe(true)
    expect(result.decision).not.toBe("block")
  })
})
