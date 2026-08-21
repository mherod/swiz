/**
 * Every task-store entry point must keep a hostile `session_id` inside the store.
 *
 * `session_id` arrives verbatim from agent hook stdin. The original guard covered
 * `task-repository.ts` alone, leaving ten `join(tasksDir, sessionId)` sites — two of them
 * writes and three of them deletion targets — free to escape. These tests pin both halves of
 * the contract: writes and deletes refuse a traversing id, reads return their ordinary empty
 * result, and nothing appears on disk outside `tasksDir`.
 *
 * Each traversal assertion is paired with an ordinary-id control, because an assertion that
 * "nothing was created outside the store" also passes when the call never reached the guard.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync } from "node:fs"
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { codexPlanSyncMarkerPath } from "./codex-update-plan.ts"
import { readAuditLog, readRecentAuditEntries } from "./task-audit-verification.ts"
import { isSafeSessionId, sessionDirPath } from "./task-store-path.ts"

/** Ids that must never resolve to a directory outside the store. */
const HOSTILE_IDS = ["../../etc/passwd", "a/../../../../escaped", "..", "../sibling", "   ", ""]

const ORDINARY_ID = "7ed7644d-3b7c-4d02-8278-9aa2d4059950"

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

/** A throwaway store root with a sibling directory that an escape would land in. */
async function makeStore(): Promise<{ root: string; tasksDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "swiz-containment-"))
  roots.push(root)
  const tasksDir = join(root, "home", ".claude", "tasks")
  mkdirSync(tasksDir, { recursive: true })
  return { root, tasksDir }
}

/** Everything under `root` except the store itself — an escape shows up here. */
async function outsideStoreEntries(root: string): Promise<string[]> {
  const home = join(root, "home")
  const [rootEntries, homeEntries] = await Promise.all([
    readdir(root).catch(() => [] as string[]),
    readdir(home).catch(() => [] as string[]),
  ])
  return [...rootEntries.filter((e) => e !== "home"), ...homeEntries.filter((e) => e !== ".claude")]
}

describe("sessionDirPath", () => {
  test.each(HOSTILE_IDS)("refuses %p", async (sessionId) => {
    const { tasksDir } = await makeStore()
    expect(() => sessionDirPath(sessionId, tasksDir)).toThrow(/outside the task store/)
  })

  test("control: an ordinary id resolves inside the store", async () => {
    const { tasksDir } = await makeStore()
    expect(sessionDirPath(ORDINARY_ID, tasksDir)).toBe(join(tasksDir, ORDINARY_ID))
  })

  test("an absolute-looking id stays inside the store rather than rebasing on root", async () => {
    const { tasksDir } = await makeStore()
    // `join` keeps it contained; only `resolve` would honour the leading slash.
    expect(sessionDirPath("/etc/passwd", tasksDir).startsWith(tasksDir)).toBe(true)
  })
})

describe("codexPlanSyncMarkerPath", () => {
  test("refuses a traversing id so no marker is written outside the store", async () => {
    const { root, tasksDir } = await makeStore()
    expect(() => codexPlanSyncMarkerPath("../../etc/passwd", tasksDir)).toThrow()
    expect(await outsideStoreEntries(root)).toEqual([])
  })

  test("control: an ordinary id yields a marker path under the session directory", async () => {
    const { tasksDir } = await makeStore()
    expect(
      codexPlanSyncMarkerPath(ORDINARY_ID, tasksDir).startsWith(join(tasksDir, ORDINARY_ID))
    ).toBe(true)
  })
})

describe("audit log reads", () => {
  test("a traversing id reads empty instead of throwing into a stop hook", async () => {
    const { tasksDir } = await makeStore()
    expect(await readAuditLog("../../etc/passwd", tasksDir)).toEqual([])
    expect(await readRecentAuditEntries("../../etc/passwd", 5, tasksDir)).toEqual([])
  })

  test("control: an ordinary id reads the entries actually on disk", async () => {
    const { tasksDir } = await makeStore()
    const dir = join(tasksDir, ORDINARY_ID)
    mkdirSync(dir, { recursive: true })
    const entry = { timestamp: "2026-01-01T00:00:00.000Z", taskId: "1", action: "create" }
    await writeFile(join(dir, ".audit-log.jsonl"), `${JSON.stringify(entry)}\n`)

    const all = await readAuditLog(ORDINARY_ID, tasksDir)
    expect(all).toHaveLength(1)
    expect(all[0]?.taskId).toBe("1")
    // Proves the empty results above came from the guard, not from an unreadable fixture.
    expect(await readRecentAuditEntries(ORDINARY_ID, 5, tasksDir)).toHaveLength(1)
  })
})

describe("isSafeSessionId", () => {
  test.each(HOSTILE_IDS)("rejects %p", async (sessionId) => {
    const { tasksDir } = await makeStore()
    expect(isSafeSessionId(sessionId, tasksDir)).toBe(false)
  })

  test("control: accepts an ordinary id and a nested-but-contained one", async () => {
    const { tasksDir } = await makeStore()
    expect(isSafeSessionId(ORDINARY_ID, tasksDir)).toBe(true)
    expect(isSafeSessionId("nested/child", tasksDir)).toBe(true)
  })
})
