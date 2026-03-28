import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import { runHook as runHookScript } from "./utils/test-utils.ts"

const HOOK_PATH = resolve(process.cwd(), "hooks/pretooluse-no-issue-close.ts")

interface HookResult {
  blocked: boolean
  reason: string
}

async function runHook(command: string): Promise<HookResult> {
  const result = await runHookScript(HOOK_PATH, {
    tool_name: "Bash",
    tool_input: { command },
    session_id: "test",
    cwd: "/tmp",
  })
  return {
    blocked: result.decision === "deny",
    reason: result.reason ?? "",
  }
}

describe("pretooluse-no-issue-close", () => {
  describe("blocks issue-closing commands", () => {
    test("gh issue close", async () => {
      const result = await runHook("gh issue close 123")
      expect(result.blocked).toBe(true)
      expect(result.reason).toContain("Fixes #")
    })

    test("gh issue close with flags", async () => {
      const result = await runHook("gh issue close 123 --reason completed")
      expect(result.blocked).toBe(true)
    })

    test("swiz issue close", async () => {
      const result = await runHook("swiz issue close 42")
      expect(result.blocked).toBe(true)
    })

    test("swiz issue resolve", async () => {
      const result = await runHook('swiz issue resolve 42 --body "done"')
      expect(result.blocked).toBe(true)
    })

    test("gh api with state=closed", async () => {
      const result = await runHook("gh api repos/owner/repo/issues/123 -X PATCH -f state=closed")
      expect(result.blocked).toBe(true)
    })
  })

  describe("allows non-closing commands", () => {
    test("git log", async () => {
      const result = await runHook("git log --oneline")
      expect(result.blocked).toBe(false)
    })

    test("gh issue view", async () => {
      const result = await runHook("gh issue view 123")
      expect(result.blocked).toBe(false)
    })

    test("gh issue list", async () => {
      const result = await runHook("gh issue list --state open")
      expect(result.blocked).toBe(false)
    })

    test("gh issue edit", async () => {
      const result = await runHook("gh issue edit 123 --add-label bug")
      expect(result.blocked).toBe(false)
    })

    test("swiz tasks complete with issue close in evidence", async () => {
      const result = await runHook(
        'swiz tasks complete 17 --evidence "note:deny on swiz issue close"'
      )
      expect(result.blocked).toBe(false)
    })

    test("git commit with Fixes # in message", async () => {
      const result = await runHook('git commit -m "fix(scope): thing\\n\\nFixes #123"')
      expect(result.blocked).toBe(false)
    })
  })

  describe("passthrough for non-shell tools", () => {
    test("non-Bash tool exits cleanly", async () => {
      const payload = JSON.stringify({
        tool_name: "Edit",
        tool_input: { command: "gh issue close 1" },
        session_id: "test",
        cwd: "/tmp",
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
      // Non-shell tool should exit without output (process.exit(0))
      expect(out.trim()).toBe("")
    })
  })
})
