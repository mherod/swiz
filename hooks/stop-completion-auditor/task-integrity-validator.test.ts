/**
 * Unit tests for task-integrity-validator.ts (#688)
 *
 * Covers the pure detection helper `detectOrphanedCompletedTasks`, which flags
 * `completed` task files present on disk but absent from the session trail
 * (the fabricated-completed-file bypass). The wrapper's block path calls
 * `mergeActionPlanIntoTasks`, which writes under the real HOME, so it is not
 * exercised in-process; the detection logic carries the meaning and is tested
 * directly against a temp tasks dir.
 */

import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SessionTask } from "../../src/tasks/task-recovery.ts"
import { detectOrphanedCompletedTasks } from "./task-integrity-validator.ts"
import type { CompletionAuditContext } from "./types.ts"

type DetectCtx = Pick<CompletionAuditContext, "gates" | "allTasks" | "tasksDir">

function gates(auditLog = true): CompletionAuditContext["gates"] {
  return { taskCreation: true, auditLog, ciEvidence: true }
}

function task(id: string, status: string, subject = `task ${id}`): SessionTask {
  return { id, status, subject }
}

/** Write a `.audit-log.jsonl` trail whose entries reference the given task IDs. */
async function writeTrail(dir: string, taskIds: string[]): Promise<void> {
  const lines = taskIds.map((id) =>
    JSON.stringify({ timestamp: "2026-06-11T00:00:00Z", action: "create", taskId: id })
  )
  await writeFile(join(dir, ".audit-log.jsonl"), `${lines.join("\n")}\n`)
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "swiz-integrity-"))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe("detectOrphanedCompletedTasks (#688)", () => {
  test("returns [] when the auditLog gate is disabled", async () => {
    await withTempDir(async (dir) => {
      await writeTrail(dir, ["1"])
      const ctx: DetectCtx = {
        gates: gates(false),
        allTasks: [task("2", "completed")],
        tasksDir: dir,
      }
      expect(await detectOrphanedCompletedTasks(ctx)).toEqual([])
    })
  })

  test("returns [] when no completed task files are on disk", async () => {
    await withTempDir(async (dir) => {
      await writeTrail(dir, ["1"])
      const ctx: DetectCtx = {
        gates: gates(),
        allTasks: [task("1", "in_progress"), task("2", "pending")],
        tasksDir: dir,
      }
      expect(await detectOrphanedCompletedTasks(ctx)).toEqual([])
    })
  })

  test("returns [] when no trail exists at all — AC3, native/legacy sessions", async () => {
    await withTempDir(async (dir) => {
      // No .audit-log.jsonl written: cannot distinguish fabricated from un-recorded.
      const ctx: DetectCtx = {
        gates: gates(),
        allTasks: [task("1", "completed")],
        tasksDir: dir,
      }
      expect(await detectOrphanedCompletedTasks(ctx)).toEqual([])
    })
  })

  test("returns [] when the trail file is present but empty — AC3", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, ".audit-log.jsonl"), "\n  \n")
      const ctx: DetectCtx = {
        gates: gates(),
        allTasks: [task("1", "completed")],
        tasksDir: dir,
      }
      expect(await detectOrphanedCompletedTasks(ctx)).toEqual([])
    })
  })

  test("returns [] when the completed task is recorded in the trail (legitimate)", async () => {
    await withTempDir(async (dir) => {
      await writeTrail(dir, ["1", "2"])
      const ctx: DetectCtx = {
        gates: gates(),
        allTasks: [task("1", "completed"), task("2", "completed")],
        tasksDir: dir,
      }
      expect(await detectOrphanedCompletedTasks(ctx)).toEqual([])
    })
  })

  test("flags a completed file absent from an otherwise-active trail (fabrication)", async () => {
    await withTempDir(async (dir) => {
      // Trail records task 1 only; a `completed` file for task 99 appeared
      // out of band (no hooked tool call ever recorded it).
      await writeTrail(dir, ["1"])
      const ctx: DetectCtx = {
        gates: gates(),
        allTasks: [task("1", "completed"), task("99", "completed", "fabricated done")],
        tasksDir: dir,
      }
      const orphans = await detectOrphanedCompletedTasks(ctx)
      expect(orphans.map((t) => t.id)).toEqual(["99"])
    })
  })

  test("tolerates malformed trail lines and still flags the orphan", async () => {
    await withTempDir(async (dir) => {
      await writeFile(
        join(dir, ".audit-log.jsonl"),
        `${JSON.stringify({ action: "create", taskId: "1" })}\nnot-json{{{\n`
      )
      const ctx: DetectCtx = {
        gates: gates(),
        allTasks: [task("1", "completed"), task("2", "completed")],
        tasksDir: dir,
      }
      const orphans = await detectOrphanedCompletedTasks(ctx)
      expect(orphans.map((t) => t.id)).toEqual(["2"])
    })
  })

  test("matches trail IDs across number/string representations", async () => {
    await withTempDir(async (dir) => {
      // Some writers emit numeric taskId; on-disk task IDs are strings.
      await writeFile(
        join(dir, ".audit-log.jsonl"),
        `${JSON.stringify({ action: "create", taskId: 7 })}\n`
      )
      const ctx: DetectCtx = {
        gates: gates(),
        allTasks: [task("7", "completed")],
        tasksDir: dir,
      }
      expect(await detectOrphanedCompletedTasks(ctx)).toEqual([])
    })
  })
})
