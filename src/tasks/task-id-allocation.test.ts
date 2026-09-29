import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { useTempDir } from "../utils/test-utils.ts"

const temp = useTempDir("swiz-task-id-allocation-")
const modulePath = (rel: string) => JSON.stringify(join(process.cwd(), rel))

interface AllocationResult {
  created: string[]
  afterPrune: string
  seededFromAudit: string
}

/**
 * Task stores live under $HOME, so the scenario runs in a subprocess with HOME pointed at a
 * temporary directory (repository convention for task-store tests).
 */
async function runAllocationScenario(): Promise<AllocationResult> {
  const home = await temp.create()
  const script = `
    import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises"
    import { join } from "node:path"
    import { createDefaultTaskStore } from ${modulePath("src/task-roots.ts")}
    import { projectStoreKey } from ${modulePath("src/tasks/task-repository.ts")}
    import { createTaskInProcess } from ${modulePath("src/tasks/task-service.ts")}
    import { readTaskStorePath } from ${modulePath("src/tasks/task-store-layout.ts")}

    const tasksDir = createDefaultTaskStore().tasksDir
    const create = async (cwd, subject) => {
      await mkdir(cwd, { recursive: true })
      const task = await createTaskInProcess({
        sessionId: "alloc-session",
        storeKey: projectStoreKey(cwd),
        subject,
        description: "note: fixture",
        cwd,
      })
      return task.id
    }

    // Prune-then-create: remove the highest record's file the way pruning does.
    const cwd = join(process.env.HOME, "project-a")
    const created = [
      await create(cwd, "Draft the release notes"),
      await create(cwd, "Benchmark the parser"),
      await create(cwd, "Rotate the signing keys"),
    ]
    const dir = await readTaskStorePath(projectStoreKey(cwd), tasksDir)
    for (const name of await readdir(dir)) {
      if (!name.endsWith(".json")) continue
      const record = JSON.parse(await readFile(join(dir, name), "utf-8"))
      if (record.id === created[2]) await unlink(join(dir, name))
    }
    const afterPrune = await create(cwd, "Archive the old dashboards")

    // Store from before this change: every task file pruned, only the audit log remains.
    // Learn the store's prefix from a real create, then leave an audit log naming #<prefix>-7.
    const legacyCwd = join(process.env.HOME, "project-b")
    const probe = await create(legacyCwd, "Probe the legacy prefix")
    const legacyDir = await readTaskStorePath(projectStoreKey(legacyCwd), tasksDir)
    for (const name of await readdir(legacyDir)) {
      if (name.endsWith(".json")) await unlink(join(legacyDir, name))
    }
    const legacyPrefix = probe.split("-")[0]
    await writeFile(
      join(legacyDir, ".audit-log.jsonl"),
      JSON.stringify({ timestamp: new Date().toISOString(), taskId: legacyPrefix + "-7", action: "create" }) + "\\n"
    )
    const seededFromAudit = await create(legacyCwd, "Summarise the incident review")
    console.log(JSON.stringify({ created, afterPrune, seededFromAudit }))
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
  if (proc.exitCode !== 0) throw new Error(stderr)
  return JSON.parse(stdout.trim().split("\n").at(-1)!) as AllocationResult
}

describe("task id allocation survives pruning (#972)", () => {
  test("a pruned highest id is never reissued", async () => {
    const result = await runAllocationScenario()
    const seq = (id: string) => Number(id.split("-").at(-1))
    expect(result.created.map(seq)).toEqual([1, 2, 3])
    // Allocation used to look only at files, so this would have been 3 again.
    expect(seq(result.afterPrune)).toBe(4)
  }, 30000)

  test("a store whose files were all pruned seeds from its audit log", async () => {
    const result = await runAllocationScenario()
    expect(Number(result.seededFromAudit.split("-").at(-1))).toBe(8)
  }, 30000)
})
