import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { projectKeyFromCwd } from "../project-key.ts"
import { sessionPrefix } from "../session-id.ts"
import { resolveTaskById } from "./task-resolver.ts"

// #824: sessionPrefix truncates to 4 hyphen-stripped characters, so every macOS project key
// collapses to "user" and `user-1` exists in every project at once. #826 scoped getSessions, but
// the orphan-recovery scans still walk the whole task store, so a task id can still resolve into
// another project's MCP task directory.

// Deliberately macOS-shaped home paths: that is what makes both keys collapse to the prefix
// "user", which is the collision under test. A /tmp path would yield "tmps" and prove nothing.
const PROJECT_A = "/Users/tester/Development/xproj-a"
const PROJECT_B = "/Users/tester/Development/xproj-b"
const KEY_A = projectKeyFromCwd(PROJECT_A)
const KEY_B = projectKeyFromCwd(PROJECT_B)

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
  test("every macOS project key collapses to the same prefix (premise)", () => {
    // The premise the collision rests on. Asserting the literal value too, so a fixture path that
    // silently yields a different prefix cannot make the cases below pass for the wrong reason.
    expect(sessionPrefix(KEY_A)).toBe("user")
    expect(sessionPrefix(KEY_B)).toBe("user")
  })

  test("does not resolve a task id into another project's store", async () => {
    const fx = await makeFixture()
    // Only project B has this id. Project A must not reach into it.
    await seedMcpStore(fx, KEY_B, PROJECT_B, "user-1", "project B task")

    await expect(
      resolveTaskById("user-1", KEY_A, PROJECT_A, fx.tasksDir, fx.projectsDir)
    ).rejects.toThrow()
  })

  test("resolves within the current project when the id is genuinely present", async () => {
    const fx = await makeFixture()
    await seedMcpStore(fx, KEY_A, PROJECT_A, "user-1", "project A task")
    await seedMcpStore(fx, KEY_B, PROJECT_B, "user-1", "project B task")

    const resolved = await resolveTaskById("user-1", KEY_A, PROJECT_A, fx.tasksDir, fx.projectsDir)
    expect(resolved.sessionId).toBe(KEY_A)
    expect(resolved.task.subject).toBe("project A task")
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
