import { describe, expect, test } from "bun:test"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { runBashHook, useTempDir } from "./utils/test-utils.ts"

const HOOK = "hooks/pretooluse-enforce-taskupdate.ts"
const { create: createTempDir } = useTempDir("swiz-enforce-taskupdate-")

function runHook(command: string, opts: { transcript_path?: string } = {}) {
  return runBashHook(HOOK, command, { toolName: "Bash", ...opts })
}

function assistantJsonl(toolContent: unknown[]): string {
  return JSON.stringify({
    type: "assistant",
    message: { content: toolContent },
  })
}

async function writeTranscript(dir: string, jsonlLines: string[]): Promise<string> {
  const path = join(dir, "session.jsonl")
  await writeFile(path, `${jsonlLines.join("\n")}\n`)
  return path
}

describe("pretooluse-enforce-taskupdate", () => {
  test("blocks `swiz tasks update` with denial", async () => {
    const result = await runHook("swiz tasks update 1 --status in_progress")
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("TaskUpdate tool")
    expect(result.reason).toContain("better integration")
  })

  test("blocks `swiz tasks status` with denial", async () => {
    const result = await runHook("swiz tasks status 1")
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("TaskUpdate tool")
  })

  test("allows `swiz tasks complete` with helpful guidance", async () => {
    const result = await runHook("swiz tasks complete 1 --evidence note:done")
    expect(result.decision).toBe("allow")
    expect(result.reason).toContain("swiz tasks complete")
    expect(result.reason).toContain("correct command")
  })

  test("omits complete tip when transcript already shows swiz complete with --evidence", async () => {
    const tmp = await createTempDir()
    const tPath = await writeTranscript(tmp, [
      assistantJsonl([
        {
          type: "tool_use",
          name: "Bash",
          input: { command: 'swiz tasks complete 1 --evidence "note:done"' },
        },
      ]),
    ])
    const result = await runHook("swiz tasks complete 2 --evidence note:next", {
      transcript_path: tPath,
    })
    expect(result.decision).toBe("allow")
    expect(result.reason ?? "").not.toContain("Tip:")
  })

  test("warns on `swiz tasks list` (severity warn)", async () => {
    const result = await runHook("swiz tasks list")
    expect(result.decision).toBe("allow")
    expect(result.reason).toContain("TaskList")
    expect(result.reason).toContain("native task tools")
  })

  test("omits list/get tip when transcript already used TaskList or TaskGet", async () => {
    const tmp = await createTempDir()
    const tPath = await writeTranscript(tmp, [
      assistantJsonl([{ type: "tool_use", name: "TaskList" }]),
    ])
    const result = await runHook("swiz tasks list", { transcript_path: tPath })
    expect(result.decision).toBe("allow")
    expect(result.reason ?? "").not.toContain("Tip:")
  })

  test("warns on `swiz tasks get`", async () => {
    const result = await runHook("swiz tasks get 1")
    expect(result.decision).toBe("allow")
    expect(result.reason).toContain("TaskGet")
  })

  test("allows normal commands in agent/Claude Code", async () => {
    const result = await runHook("git status")
    expect(result.decision).toBe("allow")
  })

  test("hook is active in subprocess context (simulating Claude Code)", async () => {
    // When run as subprocess with piped stdin, isRunningInAgent() returns true
    // (because process.stdin.isTTY is false). This simulates Claude Code environment.
    const result = await runHook("swiz tasks status 1")
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("TaskUpdate")
  })

  test("blocks swiz tasks with various spacing", async () => {
    const result = await runHook("swiz  tasks  update  1")
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("TaskUpdate")
  })

  test("does not block swiz tasks when used as argument", async () => {
    const result = await runHook("echo 'swiz tasks update'")
    expect(result.decision).toBe("allow")
  })

  test("blocks swiz tasks update subcommand variations", async () => {
    const result = await runHook("swiz tasks update 123 --description 'new desc'")
    expect(result.decision).toBe("deny")
  })
})
