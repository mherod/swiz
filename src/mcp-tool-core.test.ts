import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { useTempDir } from "./utils/test-utils.ts"

const tmp = useTempDir("swiz-mcp-tool-core-")

interface DriverResult {
  createdId: string
  createdText: string
  updatedText: string
  listedText: string
  emptyListedText: string
  prefixedUpdateOk: boolean
  prefixedHeadline: string
  bareUpdateOk: boolean
  unknownBareIsError: boolean
  unknownPrefixedIsError: boolean
  edgeId: string
  storedBlocks: string[] | null
  blocksAfterRemove: string[] | null
}

/**
 * runMcpTool writes through the default task store under $HOME, so the probe
 * runs in a subprocess with HOME pointed at a temp dir (repo test convention).
 */
async function runDriver(): Promise<DriverResult> {
  const home = await tmp.create()
  const cwd = join(home, "project")
  const corePath = join(process.cwd(), "src", "mcp-tool-core.ts")
  const taskRootsPath = join(process.cwd(), "src", "task-roots.ts")
  const script = `
    import { mkdir } from "node:fs/promises"
    import { runMcpTool } from ${JSON.stringify(corePath)}
    import { createDefaultTaskStore } from ${JSON.stringify(taskRootsPath)}
    const cwd = ${JSON.stringify(cwd)}
    await mkdir(cwd, { recursive: true })
    const textOf = (result) => result.content.map((part) => part.text ?? "").join("\\n")
    const emptyListed = await runMcpTool("TaskList", {}, cwd)
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
    const listed = await runMcpTool("TaskList", {}, cwd)
    const unknownBare = await runMcpTool("TaskUpdate", { taskId: "zzzz-99", status: "pending" }, cwd)
    const unknownPrefixed = await runMcpTool(
      "TaskUpdate",
      { taskId: "#zzzz-99", status: "pending" },
      cwd
    )
    const edgeFixture = await runMcpTool(
      "TaskCreate",
      { subject: "Verify the edge fixture wiring", description: "note: edge normalization probe" },
      cwd
    )
    const edgeId = /Created #(\\S+)/.exec(textOf(edgeFixture))?.[1] ?? ""
    await runMcpTool("TaskUpdate", { taskId: createdId, addBlocks: ["#" + edgeId] }, cwd)
    const { readdir } = await import("node:fs/promises")
    const tasksRoot = createDefaultTaskStore().tasksDir
    const readBlocks = async () => {
      for (const projectDir of await readdir(tasksRoot)) {
        for (const file of await readdir(tasksRoot + "/" + projectDir)) {
          if (!file.endsWith(".json")) continue
          const data = await Bun.file(tasksRoot + "/" + projectDir + "/" + file).json()
          if (data.id === createdId) return data.blocks ?? null
        }
      }
      return null
    }
    const storedBlocks = await readBlocks()
    await runMcpTool("TaskUpdate", { taskId: createdId, removeBlocks: [edgeId] }, cwd)
    const blocksAfterRemove = await readBlocks()
    console.log(
      JSON.stringify({
        createdId,
        createdText,
        updatedText: textOf(prefixed),
        listedText: textOf(listed),
        emptyListedText: textOf(emptyListed),
        prefixedUpdateOk: !prefixed.isError,
        prefixedHeadline: textOf(prefixed).split("\\n")[0] ?? "",
        bareUpdateOk: !bare.isError,
        unknownBareIsError: prefixed.isError !== true && unknownBare.isError === true,
        unknownPrefixedIsError: unknownPrefixed.isError === true,
        edgeId,
        storedBlocks,
        blocksAfterRemove,
      })
    )
  `
  const proc = Bun.spawn(["bun", "-e", script], {
    cwd: home,
    env: { ...process.env, HOME: home, AI_TEST_NO_BACKEND: "1", SWIZ_NO_DAEMON: "1" },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited
  expect(proc.exitCode).toBe(0)
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
    // Edge arrays normalize the rendered "#" form on write, and bare-form
    // removal matches the stored edge (store-corruption regression).
    expect(result.edgeId).not.toBe("")
    expect(result.storedBlocks).toEqual([result.edgeId])
    expect(result.blocksAfterRemove).toEqual([])
  }, 30000)
})

describe("MCP task governance hints", () => {
  test("appends one governance footer to create, update, populated list and empty list results", async () => {
    const result = await runDriver()

    for (const output of [
      result.createdText,
      result.updatedText,
      result.listedText,
      result.emptyListedText,
    ]) {
      expect(output.match(/^Task governance:/gm)).toHaveLength(1)
      const footer = output.slice(output.indexOf("Task governance:"))
      expect(footer).toContain("one action per subject")
      expect(footer).toContain("in_progress")
      expect(footer).toMatch(/evidence in description/)
      expect(footer).toContain("parent session")
    }

    expect(result.createdText).toStartWith(`Created #${result.createdId}`)
    expect(result.createdText).toContain("READY (1)")
    expect(result.updatedText).toStartWith(`Updated #${result.createdId}`)
    expect(result.updatedText).toContain("pending → in_progress")
    expect(result.listedText).toStartWith("Task queue for this project.")
    expect(result.listedText).toContain(`#${result.createdId}`)
    expect(result.listedText).toContain("1 in progress")
    expect(result.emptyListedText).toStartWith("No tasks in this project yet.")
    expect(result.emptyListedText).toContain("Totals: 0 task(s)")
  }, 30000)
})
