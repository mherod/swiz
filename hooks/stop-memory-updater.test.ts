import { describe, expect, test } from "bun:test"

async function runHook(input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const proc = Bun.spawn(["bun", "hooks/stop-memory-updater.ts"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  proc.stdin.write(JSON.stringify(input))
  proc.stdin.end()
  const out = await new Response(proc.stdout).text()
  await proc.exited
  return out.trim() ? JSON.parse(out.trim()) : {}
}

describe("stop-memory-updater", () => {
  test("never blocks stop (returns ok: true)", async () => {
    const result = await runHook({ cwd: "/nonexistent/path" })
    expect(result).toEqual({ ok: true })
  })

  test("returns ok when no transcript available", async () => {
    const result = await runHook({
      cwd: "/Users/matthewherod/Development/swiz",
      session_id: "nonexistent-session",
    })
    expect(result).toEqual({ ok: true })
  })

  describe("directive pattern matching", () => {
    const DIRECTIVE_RES = [
      /\balways\s+use\b/i,
      /\bnever\s+use\b/i,
      /\bdon'?t\s+use\b/i,
      /\bavoid\s+using\b/i,
      /\bstop\s+(?:using|doing)\b/i,
      /\bfrom\s+now\s+on\b/i,
      /\bgoing\s+forward\b/i,
      /\bremember\s+(?:that|to)\b/i,
      /\bprefer\s+\w+\s+over\b/i,
      /\buse\s+\w+\s+instead\s+of\b/i,
      /\bmake\s+sure\s+(?:to|that)\b/i,
      /\bthe\s+(?:rule|convention)\s+is\b/i,
      /\bwe\s+should\s+(?:always|never|use|write|keep)\b/i,
      /\bshouldn'?t\s+(?:use|assume|have|add|include)\b/i,
      /\blet'?s\s+(?:use|switch\s+to|convert|move\s+to)\b/i,
      /\bthis\s+project\s+uses\b/i,
      /\bwe\s+use\s+\w+\s+(?:for|in|across)\b/i,
      /\brather\s+than\b/i,
      /\binstead\s+(?:of|just)\b/i,
      /\bgive\s+a\s+gentle\b/i,
    ]

    function matches(text: string): boolean {
      return DIRECTIVE_RES.some((re) => re.test(text))
    }

    test("matches explicit directives", () => {
      expect(matches("always use bun instead of npm")).toBe(true)
      expect(matches("never use grep, prefer rg")).toBe(true)
      expect(matches("remember that hooks must exit 0")).toBe(true)
      expect(matches("from now on use TypeScript")).toBe(true)
      expect(matches("prefer rg over grep")).toBe(true)
      expect(matches("make sure to test everything")).toBe(true)
    })

    test("matches conversational directives", () => {
      expect(matches("we should write swiz into the configs")).toBe(true)
      expect(matches("let's convert all those legacy shell hooks")).toBe(true)
      expect(matches("shouldn't assume those skills exist")).toBe(true)
      expect(matches("this project uses bun")).toBe(true)
      expect(matches("use swiz instead of direct paths")).toBe(true)
    })

    test("rejects non-directive messages", () => {
      expect(matches("fix the bug in line 42")).toBe(false)
      expect(matches("Great work!")).toBe(false)
      expect(matches("is that our stop hook firing?")).toBe(false)
      expect(matches("Still seeing the error occur")).toBe(false)
      expect(matches("Install it and then let's continue working")).toBe(false)
    })

    test("rejects stop hook feedback messages", () => {
      expect(matches("Uncommitted changes detected")).toBe(false)
      expect(matches("Use the /push skill to push")).toBe(false)
      expect(matches("ACTION REQUIRED: You must act")).toBe(false)
    })
  })
})
