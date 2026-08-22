import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { useTempDir } from "./utils/test-utils.ts"

const tmp = useTempDir("swiz-mcp-tool-core-")

interface DriverResult {
  createdId: string
  prefixedUpdateOk: boolean
  prefixedHeadline: string
  bareUpdateOk: boolean
  unknownBareIsError: boolean
  unknownPrefixedIsError: boolean
}

/**
 * runMcpTool writes through the default task store under $HOME, so the probe
 * runs in a subprocess with HOME pointed at a temp dir (repo test convention).
 */
async function runDriver(): Promise<DriverResult> {
  const home = await tmp.create()
  const cwd = join(home, "project")
  const corePath = join(process.cwd(), "src", "mcp-tool-core.ts")
  const script = `
    import { mkdir } from "node:fs/promises"
    import { runMcpTool } from ${JSON.stringify(corePath)}
    const cwd = ${JSON.stringify(cwd)}
    await mkdir(cwd, { recursive: true })
    const textOf = (result) => result.content.map((part) => part.text ?? "").join("\\n")
    const created = await runMcpTool(
      "TaskCreate",
      { subject: "Probe the id prefix path", description: "note: issue #846 regression probe" },
      cwd
    )
    const createdText = textOf(created)
    const createdId = /Created #(\\S+)/.exec(createdText)?.[1] ?? ""
    const prefixed = await runMcpTool(
      "TaskUpdate",
      { taskId: "#" + createdId, status: "in_progress" },
      cwd
    )
    const bare = await runMcpTool(
      "TaskUpdate",
      { taskId: createdId, description: "note: bare form still works" },
      cwd
    )
    const unknownBare = await runMcpTool("TaskUpdate", { taskId: "zzzz-99", status: "pending" }, cwd)
    const unknownPrefixed = await runMcpTool(
      "TaskUpdate",
      { taskId: "#zzzz-99", status: "pending" },
      cwd
    )
    console.log(
      JSON.stringify({
        createdId,
        prefixedUpdateOk: !prefixed.isError,
        prefixedHeadline: textOf(prefixed).split("\\n")[0] ?? "",
        bareUpdateOk: !bare.isError,
        unknownBareIsError: prefixed.isError !== true && unknownBare.isError === true,
        unknownPrefixedIsError: unknownPrefixed.isError === true,
      })
    )
  `
  const proc = Bun.spawn(["bun", "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home, AI_TEST_NO_BACKEND: "1", SWIZ_NO_DAEMON: "1" },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited
  expect(stderr.includes("error")).toBe(false)
  const lastLine = stdout.trim().split("\n").at(-1) ?? "{}"
  return JSON.parse(lastLine) as DriverResult
}

describe("runTaskUpdateTool id normalization (issue #846)", () => {
  test("accepts the #-prefixed id its own output prints, and the bare form", async () => {
    const result = await runDriver()
    expect(result.createdId).not.toBe("")
    expect(result.prefixedUpdateOk).toBe(true)
    expect(result.prefixedHeadline).toContain(`Updated #${result.createdId}`)
    expect(result.bareUpdateOk).toBe(true)
    // Controls: a genuinely unknown id still errors in both forms.
    expect(result.unknownBareIsError).toBe(true)
    expect(result.unknownPrefixedIsError).toBe(true)
  }, 30000)
})
