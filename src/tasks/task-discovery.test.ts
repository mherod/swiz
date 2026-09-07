import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { projectKeyFromCwd } from "../project-key.ts"
import { neutralAgentEnv, useTempDir } from "../utils/test-utils.ts"
import { discoverRelatedTaskAdvice, selectRelatedTasks } from "./task-discovery.ts"
import type { Task } from "./task-repository.ts"

const { create } = useTempDir("swiz-discovery-")
const now = Date.now()
function task(id: string, subject = "Inspect dashboard polling", extra: Partial<Task> = {}): Task {
  return {
    id,
    subject,
    description: "private description",
    status: "pending",
    blocks: [],
    blockedBy: [],
    statusChangedAt: new Date(now).toISOString(),
    ...extra,
  }
}

test("ranks meaningful subjects, bounds advice and excludes expired or cancelled work", () => {
  const tasks = [
    task("new"),
    task("cancelled", undefined, { status: "cancelled" }),
    task("expired", undefined, { status: "completed", completedAt: now - 16 * 60_000 }),
    task("recent", undefined, { status: "completed", completedAt: now - 60_000 }),
    task("unrelated", "Inspect database indexes"),
    ...Array.from({ length: 8 }, (_, i) => task(`peer-${i}`)),
  ]
  const result = selectRelatedTasks("Fix dashboard rendering", "new", tasks, now)
  expect(result).toHaveLength(5)
  expect(result.map((t) => t.id)).not.toContain("new")
  expect(result.map((t) => t.id)).not.toContain("cancelled")
  expect(result.map((t) => t.id)).not.toContain("expired")
  expect(result.map((t) => t.id)).not.toContain("unrelated")
  expect(selectRelatedTasks("Fix dashboard rendering", "new", [tasks[3]!], now)).toHaveLength(1)
  expect(selectRelatedTasks("Inspect database indexes", "new", [task("peer")], now)).toEqual([])
})

test("MCP create with an empty project queue reports peer work without rejecting", async () => {
  const home = await create()
  const cwd = join(home, "project")
  await mkdir(cwd)
  const corePath = join(import.meta.dir, "../mcp-tool-core.ts")
  const rootsPath = join(import.meta.dir, "../task-roots.ts")
  const code = `
    import { mkdir } from "node:fs/promises";
    import { runMcpTool } from ${JSON.stringify(corePath)};
    import { createDefaultTaskStore } from ${JSON.stringify(rootsPath)};
    const cwd = ${JSON.stringify(cwd)};
    const { tasksDir } = createDefaultTaskStore();
    const peerDir = tasksDir + "/peer-session";
    await mkdir(peerDir, { recursive: true });
    await Bun.write(peerDir + "/.session-meta.json", JSON.stringify({ cwd }));
    await Bun.write(peerDir + "/peer-1.json", JSON.stringify(${JSON.stringify(task("peer-1"))}));
    const result = await runMcpTool("TaskCreate", { subject: "Fix dashboard rendering", description: "note: discovery probe" }, cwd);
    process.stdout.write(JSON.stringify(result));
  `
  const proc = Bun.spawn([process.execPath, "-e", code], {
    cwd,
    env: neutralAgentEnv({ HOME: home, AI_TEST_NO_BACKEND: "1" }),
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10_000,
  })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  expect(await proc.exited).toBe(0)
  expect(stderr).toBe("")
  const result = JSON.parse(stdout)
  expect(result.isError).not.toBe(true)
  expect(result.structuredContent.taskMutation.changed).toBe(true)
  expect(result.content[0].text).toContain("Related project work (advisory):")
  expect(result.content[0].text).toContain("#peer-1")
  expect(result.content[0].text).not.toContain("private description")
}, 15_000)

test("cross-store discovery requires project attribution and merges status recency", async () => {
  const root = await create()
  const cwd = join(root, "project")
  const store = { tasksDir: join(root, "tasks"), projectsDir: join(root, "projects") }
  const seed = async (key: string, owner: string | null, tasks: Task[]) => {
    const dir = join(store.tasksDir, key)
    await mkdir(dir, { recursive: true })
    if (owner) await Bun.write(join(dir, ".session-meta.json"), JSON.stringify({ cwd: owner }))
    for (const item of tasks) await Bun.write(join(dir, `${item.id}.json`), JSON.stringify(item))
  }
  const key = projectKeyFromCwd(cwd)
  await seed(key, cwd, [
    task("same", undefined, { statusChangedAt: new Date(now - 1000).toISOString() }),
  ])
  await seed("peer-session", cwd, [task("peer"), task("same", undefined, { status: "cancelled" })])
  await seed("foreign-session", join(root, "other"), [task("foreign")])
  await seed("orphan-session", null, [task("orphan")])
  const advice = await discoverRelatedTaskAdvice(cwd, task("new", "Fix dashboard rendering"), {
    store,
    now,
  })
  expect(advice).toContain("#peer")
  for (const excluded of ["#same", "#foreign", "#orphan", "private description"])
    expect(advice).not.toContain(excluded)
  expect(advice).toContain("pending; 0m ago")
  expect(
    await discoverRelatedTaskAdvice(cwd, task("new"), {
      store,
      read: async () => {
        throw new Error("read failed")
      },
    })
  ).toBe("")
  expect(await Bun.file(join(store.tasksDir, "peer-session", "peer.json")).exists()).toBe(true)
})
