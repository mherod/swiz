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
  mutationOutcomes: Array<boolean | undefined>
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
  const repositoryPath = join(process.cwd(), "src", "tasks", "task-repository.ts")
  const discoveryPath = join(process.cwd(), "src", "tasks", "task-discovery.ts")
  const script = `
    import { mock } from "bun:test"
    import { mkdir } from "node:fs/promises"
    mock.module(${JSON.stringify(discoveryPath)}, () => ({ discoverRelatedTaskAdvice: async () => "" }))
    const { runMcpTool } = await import(${JSON.stringify(corePath)})
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
    const unchanged = await runMcpTool("TaskUpdate", { taskId: createdId, description: "note: bare form still works" }, cwd)
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
    const { readTaskStore, projectStoreKey } = await import(${JSON.stringify(repositoryPath)})
    const tasksRoot = createDefaultTaskStore().tasksDir
    const readBlocks = async () => (await readTaskStore(projectStoreKey(cwd), tasksRoot)).find(task => task.id === createdId)?.blocks ?? null
    const storedBlocks = await readBlocks()
    await runMcpTool("TaskUpdate", { taskId: createdId, removeBlocks: [edgeId] }, cwd)
    const blocksAfterRemove = await readBlocks()
    console.log(
      JSON.stringify({
        createdId,
        mutationOutcomes: [created, prefixed, bare, unchanged].map(result => result.structuredContent?.taskMutation?.changed),
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
  return spawnCoreScript<DriverResult>(home, script)
}

async function spawnCoreScript<T>(home: string, script: string): Promise<T> {
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
  // Services must leave stdout exclusively to the stdio JSON-RPC transport (#933).
  return JSON.parse(stdout) as T
}

interface RootCwdResult {
  ids: string[]
  summaryMatchesText: boolean
  emptyCreate: { isError: boolean; text: string }
  emptyUpdate: { isError: boolean; text: string }
  selfBlock: { isError: boolean; text: string }
  subjectsAfterRejections: string[]
}

/**
 * Claude desktop launches `swiz mcp` with cwd "/", whose project key is "-".
 * Drives the tools against that key with HOME pointed at a temp dir.
 */
async function runRootCwdDriver(): Promise<RootCwdResult> {
  const home = await tmp.create()
  const corePath = join(process.cwd(), "src", "mcp-tool-core.ts")
  const taskRootsPath = join(process.cwd(), "src", "task-roots.ts")
  const repositoryPath = join(process.cwd(), "src", "tasks", "task-repository.ts")
  const discoveryPath = join(process.cwd(), "src", "tasks", "task-discovery.ts")
  const script = `
    import { mock } from "bun:test"
    mock.module(${JSON.stringify(discoveryPath)}, () => ({ discoverRelatedTaskAdvice: async () => "" }))
    const { runMcpTool } = await import(${JSON.stringify(corePath)})
    const { createDefaultTaskStore } = await import(${JSON.stringify(taskRootsPath)})
    const { readTaskStore, projectStoreKey } = await import(${JSON.stringify(repositoryPath)})
    const cwd = "/"
    const textOf = (result) => result.content.map((part) => part.text ?? "").join("\\n")
    const outcome = (result) => ({ isError: result.isError === true, text: textOf(result) })
    const first = await runMcpTool("TaskCreate", { subject: "Probe the root cwd store", description: "note: fixture" }, cwd)
    const second = await runMcpTool("TaskCreate", { subject: "Verify the second id", description: "note: fixture" }, cwd)
    const ids = [first, second].map((result) => /Created #(\\S+)/.exec(textOf(result))?.[1] ?? "")
    const emptyCreate = await runMcpTool("TaskCreate", { subject: "", description: "note: fixture" }, cwd)
    const emptyUpdate = await runMcpTool("TaskUpdate", { taskId: ids[0], subject: "  " }, cwd)
    const selfBlock = await runMcpTool("TaskUpdate", { taskId: ids[0], addBlockedBy: ["#" + ids[0]] }, cwd)
    const readSubjects = async () =>
      (await readTaskStore(projectStoreKey(cwd), createDefaultTaskStore().tasksDir)).map((task) => task.subject).sort()
    console.log(
      JSON.stringify({
        ids,
        summaryMatchesText: [first, second].every((result) => result.structuredContent?.summary === textOf(result)),
        emptyCreate: outcome(emptyCreate),
        emptyUpdate: outcome(emptyUpdate),
        selfBlock: outcome(selfBlock),
        subjectsAfterRejections: await readSubjects(),
      })
    )
  `
  return spawnCoreScript<RootCwdResult>(home, script)
}

describe("MCP task tools under the root cwd (project key '-')", () => {
  test("keeps both tasks and rejects writes that would hide or self-block a task", async () => {
    const result = await runRootCwdDriver()

    // Each create gets its own parseable id instead of reusing and overwriting "--1".
    expect(result.ids[0]).toMatch(/^[0-9a-f]{4}-1$/)
    expect(result.ids[1]).toMatch(/^[0-9a-f]{4}-2$/)
    // Mutation results repeat their text as structuredContent.summary for the model.
    expect(result.summaryMatchesText).toBe(true)

    expect(result.emptyCreate.isError).toBe(true)
    expect(result.emptyCreate.text).toContain("subject must not be empty")
    expect(result.emptyUpdate.isError).toBe(true)
    expect(result.emptyUpdate.text).toContain("subject must not be empty")
    expect(result.selfBlock.isError).toBe(true)
    expect(result.selfBlock.text).toContain("cannot block itself")

    // Control: both originals survive every rejected write, unchanged.
    expect(result.subjectsAfterRejections).toEqual([
      "Probe the root cwd store",
      "Verify the second id",
    ])
  }, 30000)
})

describe("runTaskUpdateTool id normalization (issue #846)", () => {
  test("accepts the #-prefixed id its own output prints, and the bare form", async () => {
    const result = await runDriver()
    expect(result.createdId).not.toBe("")
    expect(result.prefixedUpdateOk).toBe(true)
    expect(result.prefixedHeadline).toContain(`Updated #${result.createdId}`)
    expect(result.bareUpdateOk).toBe(true)
    expect(result.mutationOutcomes).toEqual([true, true, true, false])
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
  test("keeps sequential create, update and list results focused on the current queue", async () => {
    const result = await runDriver()

    for (const output of [
      result.createdText,
      result.updatedText,
      result.listedText,
      result.emptyListedText,
    ]) {
      expect(output).not.toContain("Task governance:")
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
