import { describe, expect, test } from "bun:test"
import { runHook } from "../src/utils/test-utils.ts"

const HOOK = "hooks/pretooluse-enforce-taskupdate.ts"

function bashPayload(command: string) {
  return { tool_name: "Bash", tool_input: { command } }
}

function runClaudeHook(command: string) {
  return runHook(HOOK, bashPayload(command), {
    CLAUDECODE: "1",
    CODEX_MANAGED_BY_NPM: undefined,
    CODEX_THREAD_ID: undefined,
    CURSOR_TRACE_ID: undefined,
    GEMINI_CLI: undefined,
    GEMINI_PROJECT_DIR: undefined,
  })
}

function runCodexHook(command: string) {
  return runHook(HOOK, bashPayload(command), {
    CLAUDECODE: undefined,
    CODEX_MANAGED_BY_NPM: "1",
    CODEX_THREAD_ID: "test-codex-thread",
    CURSOR_TRACE_ID: undefined,
    GEMINI_CLI: undefined,
    GEMINI_PROJECT_DIR: undefined,
  })
}

describe("pretooluse-enforce-taskupdate", () => {
  test("blocks `swiz tasks update` with denial", async () => {
    const result = await runClaudeHook("swiz tasks update 1 --status in_progress")
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("native task tools")
    expect(result.reason).toContain("TaskUpdate")
  })

  test("blocks `swiz tasks status` with denial", async () => {
    const result = await runClaudeHook("swiz tasks status 1")
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("TaskUpdate")
  })

  test("blocks `swiz tasks complete`", async () => {
    const result = await runClaudeHook("swiz tasks complete 1 --evidence note:done")
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("swiz tasks")
    expect(result.reason).toContain("TaskUpdate")
  })

  test("blocks `swiz tasks list`", async () => {
    const result = await runClaudeHook("swiz tasks list")
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("TaskList")
  })

  test("blocks `swiz tasks get`", async () => {
    const result = await runClaudeHook("swiz tasks get 1")
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("TaskGet")
  })

  test("allows `swiz tasks adopt` (orphan recovery)", async () => {
    const result = await runClaudeHook("swiz tasks adopt")
    expect(result.decision).toBe("allow")
  })

  test("allows `swiz tasks adopt --recovered`", async () => {
    const result = await runClaudeHook("swiz tasks adopt --recovered")
    expect(result.decision).toBe("allow")
  })

  test("allows normal commands in agent/Claude Code", async () => {
    const result = await runClaudeHook("git status")
    expect(result.decision).toBe("allow")
  })

  test("hook is active in subprocess context (simulating Claude Code)", async () => {
    const result = await runClaudeHook("swiz tasks status 1")
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("TaskUpdate")
  })

  test("blocks swiz tasks with various spacing", async () => {
    const result = await runClaudeHook("swiz  tasks  update  1")
    expect(result.decision).toBe("deny")
  })

  test("does not block swiz tasks when used as argument", async () => {
    const result = await runClaudeHook("echo 'swiz tasks update'")
    expect(result.decision).toBe("allow")
  })

  test("blocks swiz tasks update subcommand variations", async () => {
    const result = await runClaudeHook("swiz tasks update 123 --description 'new desc'")
    expect(result.decision).toBe("deny")
  })

  test("blocks bare `swiz tasks` (list)", async () => {
    const result = await runClaudeHook("swiz tasks")
    expect(result.decision).toBe("deny")
  })

  test("does not apply the Claude-only swiz tasks block in Codex", async () => {
    const result = await runCodexHook("swiz tasks")
    expect(result.decision).not.toBe("deny")
    expect(result.reason ?? "").not.toContain("Claude Code")
  })
})
