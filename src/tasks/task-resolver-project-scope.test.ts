import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { projectKeyFromCwd } from "../project-key.ts"
import { getSessions } from "./task-resolver.ts"

// #826: session selection admitted *any* directory absent from every project's transcript list.
// The MCP store is keyed by projectKeyFromCwd(cwd) and never produces a .jsonl, so it is
// structurally invisible to that check — and so is every *other* project's MCP store, which was
// therefore swept in even with filterCwd set.

const PROJECT_A = "/tmp/swiz-scope-project-a"
const PROJECT_B = "/tmp/swiz-scope-project-b"
const KEY_A = projectKeyFromCwd(PROJECT_A)
const KEY_B = projectKeyFromCwd(PROJECT_B)

const roots: string[] = []

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop()
    if (root) await rm(root, { recursive: true, force: true })
  }
})

interface Fixture {
  tasksDir: string
  projectsDir: string
}

async function makeFixture(): Promise<Fixture> {
  const root = join(tmpdir(), `swiz-scope-${process.pid}-${roots.length}-${Math.random()}`)
  roots.push(root)
  const tasksDir = join(root, "tasks")
  const projectsDir = join(root, "projects")
  await mkdir(tasksDir, { recursive: true })
  await mkdir(projectsDir, { recursive: true })
  return { tasksDir, projectsDir }
}

/** A task store directory as the MCP server writes it: project-keyed, with cwd in its meta. */
async function seedMcpStore(fx: Fixture, storeKey: string, cwd: string): Promise<void> {
  const dir = join(fx.tasksDir, storeKey)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, "user-1.json"),
    JSON.stringify({ id: "user-1", subject: "s", description: "d", status: "pending" })
  )
  await writeFile(
    join(dir, ".session-meta.json"),
    JSON.stringify({ openCount: 1, updatedAt: new Date().toISOString(), cwd })
  )
}

/** A native session: a task dir plus the transcript that attributes it to a project. */
async function seedNativeSession(fx: Fixture, sessionId: string, cwd: string): Promise<void> {
  const dir = join(fx.tasksDir, sessionId)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, `${sessionId}-1.json`),
    JSON.stringify({ id: `${sessionId}-1`, subject: "s", description: "d", status: "pending" })
  )
  const projectDir = join(fx.projectsDir, projectKeyFromCwd(cwd))
  await mkdir(projectDir, { recursive: true })
  await writeFile(join(projectDir, `${sessionId}.jsonl`), `${JSON.stringify({ cwd })}\n`)
}

describe("getSessions project scoping", () => {
  test("includes this project's own MCP store", async () => {
    const fx = await makeFixture()
    await seedMcpStore(fx, KEY_A, PROJECT_A)
    const sessions = await getSessions(PROJECT_A, fx.tasksDir, fx.projectsDir)
    expect(sessions).toContain(KEY_A)
  })

  test("excludes another project's MCP store when filterCwd is set", async () => {
    const fx = await makeFixture()
    await seedMcpStore(fx, KEY_A, PROJECT_A)
    await seedMcpStore(fx, KEY_B, PROJECT_B)
    const sessions = await getSessions(PROJECT_A, fx.tasksDir, fx.projectsDir)
    expect(sessions).toContain(KEY_A)
    expect(sessions).not.toContain(KEY_B)
  })

  test("includes both MCP stores when no filterCwd is given", async () => {
    // --all-projects must remain the way to widen scope.
    const fx = await makeFixture()
    await seedMcpStore(fx, KEY_A, PROJECT_A)
    await seedMcpStore(fx, KEY_B, PROJECT_B)
    const sessions = await getSessions(undefined, fx.tasksDir, fx.projectsDir)
    expect(sessions).toContain(KEY_A)
    expect(sessions).toContain(KEY_B)
  })

  test("keeps native sessions scoped to their own project", async () => {
    const fx = await makeFixture()
    await seedNativeSession(fx, "00000000-0000-0000-0000-0000000000a1", PROJECT_A)
    await seedNativeSession(fx, "00000000-0000-0000-0000-0000000000b1", PROJECT_B)
    const sessions = await getSessions(PROJECT_A, fx.tasksDir, fx.projectsDir)
    expect(sessions).toContain("00000000-0000-0000-0000-0000000000a1")
    expect(sessions).not.toContain("00000000-0000-0000-0000-0000000000b1")
  })

  test("still admits an unattributable orphan directory", async () => {
    // A task dir with no meta cwd and no transcript cannot be attributed to any project. It must
    // stay visible or compaction-gap recovery loses it entirely.
    const fx = await makeFixture()
    const orphan = "00000000-0000-0000-0000-0000000000c1"
    await mkdir(join(fx.tasksDir, orphan), { recursive: true })
    await writeFile(
      join(fx.tasksDir, orphan, `${orphan}-1.json`),
      JSON.stringify({ id: `${orphan}-1`, subject: "s", description: "d", status: "pending" })
    )
    const sessions = await getSessions(PROJECT_A, fx.tasksDir, fx.projectsDir)
    expect(sessions).toContain(orphan)
  })
})
