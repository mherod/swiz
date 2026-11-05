/**
 * Contract: ownership detection must recognise the swiz MCP task tools' real output.
 *
 * `collectSessionOwnedTaskIds` matches result wording ("Created #id", "Updated #id — …
 * (old → new"). Hand-written fixtures would keep passing if that wording drifted, and the
 * failure mode is silent: every shared-list row would read as nobody's and the refresh gates
 * would stand down for it. This drives the real tools and parses what they actually print.
 */
import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { useTempDir } from "../utils/test-utils.ts"
import { collectSessionOwnedTaskIds } from "./session-task-ownership.ts"

const tmp = useTempDir("swiz-ownership-contract-")

interface ToolTexts {
  createdId: string
  created: string
  started: string
  noted: string
}

/** runMcpTool writes under $HOME, so run it in a subprocess with a temp HOME. */
async function captureRealToolTexts(): Promise<ToolTexts> {
  const home = await tmp.create()
  const cwd = join(home, "project")
  const corePath = join(process.cwd(), "src", "mcp-tool-core.ts")
  const discoveryPath = join(process.cwd(), "src", "tasks", "task-discovery.ts")
  const script = `
    import { mock } from "bun:test"
    import { mkdir } from "node:fs/promises"
    mock.module(${JSON.stringify(discoveryPath)}, () => ({ discoverRelatedTaskAdvice: async () => "" }))
    const { runMcpTool } = await import(${JSON.stringify(corePath)})
    const cwd = ${JSON.stringify(cwd)}
    await mkdir(cwd, { recursive: true })
    const textOf = (result) => result.content.map((part) => part.text ?? "").join("\\n")
    const created = textOf(await runMcpTool("TaskCreate", { subject: "Own this work", description: "d" }, cwd))
    const createdId = /#([A-Za-z0-9][\\w-]*)/.exec(created)?.[1] ?? ""
    const started = textOf(await runMcpTool("TaskUpdate", { taskId: createdId, status: "in_progress" }, cwd))
    const noted = textOf(await runMcpTool("TaskUpdate", { taskId: createdId, description: "note only" }, cwd))
    console.log(JSON.stringify({ createdId, created, started, noted }))
  `
  const proc = Bun.spawn(["bun", "-e", script], {
    cwd: home,
    env: { ...process.env, HOME: home, AI_TEST_NO_BACKEND: "1" },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited
  if (proc.exitCode !== 0) throw new Error(`driver failed: ${stderr}`)
  const lastLine = stdout.trim().split("\n").at(-1) ?? ""
  return JSON.parse(lastLine) as ToolTexts
}

/** Transcript lines in Claude's shape for one MCP tool call and its result. */
function call(id: string, name: string, text: string): string[] {
  return [
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id, name, input: {} }] },
    }),
    JSON.stringify({
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text }] }],
      },
    }),
  ]
}

describe("ownership detection against real swiz MCP task-tool output", () => {
  test("claims on create and on a status change, never on a note-only update", async () => {
    const texts = await captureRealToolTexts()
    expect(texts.createdId).not.toBe("")

    expect(collectSessionOwnedTaskIds(call("a", "mcp__swiz__TaskCreate", texts.created))).toEqual(
      new Set([texts.createdId])
    )
    expect(collectSessionOwnedTaskIds(call("b", "mcp__swiz__TaskUpdate", texts.started))).toEqual(
      new Set([texts.createdId])
    )
    expect(collectSessionOwnedTaskIds(call("c", "mcp__swiz__TaskUpdate", texts.noted)).size).toBe(0)
  }, 30_000)
})
