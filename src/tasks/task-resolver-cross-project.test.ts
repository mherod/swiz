import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { projectKeyFromCwd } from "../project-key.ts"
import { sessionPrefix } from "../session-id.ts"
import { resolveTaskById } from "./task-resolver.ts"

// #824: sessionPrefix derives a 4-hex SHA-256 hash for path-derived store keys so distinct
// macOS projects never collide on prefix "user". Legacy "user-*" task IDs remain resolvable
// within their project via single-match fallback.

// Deliberately macOS-shaped home paths: previously every macOS key collapsed to "user".
const PROJECT_A = "/Users/tester/Development/xproj-a"
const PROJECT_B = "/Users/tester/Development/xproj-b"
const PROJECT_C = "/Users/tester/Development/xproj-c"
const KEY_A = projectKeyFromCwd(PROJECT_A)
const KEY_B = projectKeyFromCwd(PROJECT_B)
const KEY_C = projectKeyFromCwd(PROJECT_C)

const roots: string[] = []

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop()
    if (root) await rm(root, { recursive: true, force: true })
  }
})

async function makeFixture() {
  const root = join(tmpdir(), `swiz-xproj-${process.pid}-${roots.length}-${Math.random()}`)
  roots.push(root)
  const tasksDir = join(root, "tasks")
  const projectsDir = join(root, "projects")
  await mkdir(tasksDir, { recursive: true })
  await mkdir(projectsDir, { recursive: true })
  return { tasksDir, projectsDir }
}

async function seedMcpStore(
  fx: { tasksDir: string },
  storeKey: string,
  cwd: string,
  taskId: string,
  subject: string
) {
  const dir = join(fx.tasksDir, storeKey)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, `${taskId}.json`),
    JSON.stringify({
      id: taskId,
      subject,
      description: "d",
      status: "pending",
      blocks: [],
      blockedBy: [],
    })
  )
  await writeFile(
    join(dir, ".session-meta.json"),
    JSON.stringify({ openCount: 1, updatedAt: new Date().toISOString(), cwd })
  )
}

describe("cross-project task resolution", () => {
  test("distinct macOS project keys produce distinct prefixes (#824)", () => {
    const prefixA = sessionPrefix(KEY_A)
    const prefixB = sessionPrefix(KEY_B)
    const prefixC = sessionPrefix(KEY_C)

    expect(prefixA).not.toBe(prefixB)
    expect(prefixB).not.toBe(prefixC)
    expect(prefixA).not.toBe(prefixC)
    expect(prefixA).toMatch(/^[0-9a-f]{4}$/)
    expect(prefixB).toMatch(/^[0-9a-f]{4}$/)
    expect(prefixC).toMatch(/^[0-9a-f]{4}$/)
  })

  test("does not resolve a task id into another project's store", async () => {
    const fx = await makeFixture()
    const taskBId = `${sessionPrefix(KEY_B)}-1`
    // Only project B has this id. Project A must not reach into it.
    await seedMcpStore(fx, KEY_B, PROJECT_B, taskBId, "project B task")

    await expect(
      resolveTaskById(taskBId, KEY_A, PROJECT_A, fx.tasksDir, fx.projectsDir)
    ).rejects.toThrow()
  })

  test("resolves within the current project when the id is genuinely present", async () => {
    const fx = await makeFixture()
    const taskAId = `${sessionPrefix(KEY_A)}-1`
    const taskBId = `${sessionPrefix(KEY_B)}-1`
    await seedMcpStore(fx, KEY_A, PROJECT_A, taskAId, "project A task")
    await seedMcpStore(fx, KEY_B, PROJECT_B, taskBId, "project B task")

    const resolved = await resolveTaskById(taskAId, KEY_A, PROJECT_A, fx.tasksDir, fx.projectsDir)
    expect(resolved.sessionId).toBe(KEY_A)
    expect(resolved.task.subject).toBe("project A task")
  })

  test("resolves legacy user-1 prefixed tasks via fallback", async () => {
    const fx = await makeFixture()
    await seedMcpStore(fx, KEY_A, PROJECT_A, "user-1", "legacy project A task")

    const resolved = await resolveTaskById("user-1", KEY_A, PROJECT_A, fx.tasksDir, fx.projectsDir)
    expect(resolved.sessionId).toBe(KEY_A)
    expect(resolved.task.subject).toBe("legacy project A task")
  })

  test("fails loudly when two sessions in this project both hold the id", async () => {
    // Same-project ambiguity is still possible after the cross-project leak is closed: two
    // sessions can share a four-character prefix. Naming both beats mutating whichever sorted
    // first.
    const fx = await makeFixture()
    await seedMcpStore(fx, KEY_A, PROJECT_A, "user-1", "project A task")
    const sibling = "user1111-0000-4000-8000-000000000000"
    const dir = join(fx.tasksDir, sibling)
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, "user-1.json"),
      JSON.stringify({
        id: "user-1",
        subject: "sibling task",
        description: "d",
        status: "pending",
        blocks: [],
        blockedBy: [],
      })
    )
    await writeFile(
      join(dir, ".session-meta.json"),
      JSON.stringify({ openCount: 1, updatedAt: new Date().toISOString(), cwd: PROJECT_A })
    )

    // The primary session is deliberately one that neither holds the id nor shares its prefix:
    // naming a session is itself the disambiguation, so the guard belongs on the fallback path.
    const unrelatedPrimary = "zzzz1111-0000-4000-8000-000000000000"
    await expect(
      resolveTaskById("user-1", unrelatedPrimary, PROJECT_A, fx.tasksDir, fx.projectsDir)
    ).rejects.toThrow(/ambiguous/)
  })

  test("resolves normally when the named primary session holds the id", async () => {
    // Guards the boundary above: naming the session must keep working, not trip the guard.
    const fx = await makeFixture()
    await seedMcpStore(fx, KEY_A, PROJECT_A, "user-1", "project A task")

    const resolved = await resolveTaskById("user-1", KEY_A, PROJECT_A, fx.tasksDir, fx.projectsDir)
    expect(resolved.sessionId).toBe(KEY_A)
  })

  test("still recovers an unattributable orphan in this project", async () => {
    // The orphan scans exist for compaction gaps; narrowing them must not break that.
    const fx = await makeFixture()
    const orphan = "aaaa1111-0000-4000-8000-000000000000"
    const dir = join(fx.tasksDir, orphan)
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, "aaaa-9.json"),
      JSON.stringify({
        id: "aaaa-9",
        subject: "orphaned task",
        description: "d",
        status: "pending",
        blocks: [],
        blockedBy: [],
      })
    )

    const resolved = await resolveTaskById("aaaa-9", KEY_A, PROJECT_A, fx.tasksDir, fx.projectsDir)
    expect(resolved.sessionId).toBe(orphan)
  })
})
