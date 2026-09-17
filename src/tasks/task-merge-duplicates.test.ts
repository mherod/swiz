import { describe, expect, it } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type MergeableTask,
  mergeDuplicateTaskFiles,
  mergeGroup,
  planDuplicateMerges,
  selectSurvivor,
} from "./task-merge-duplicates.ts"

async function makeStoreDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "swiz-task-merge-"))
}

async function writeTaskFile(dir: string, task: MergeableTask): Promise<void> {
  await writeFile(join(dir, `${task.id}.json`), JSON.stringify(task))
}

function fileExists(dir: string, id: string): Promise<boolean> {
  return Bun.file(join(dir, `${id}.json`)).exists()
}

function stub(id: string, overrides: Partial<MergeableTask> = {}): MergeableTask {
  return { id, subject: "Push branch to remote", status: "pending", ...overrides }
}

describe("selectSurvivor", () => {
  it("prefers in_progress over pending", () => {
    const survivor = selectSurvivor([stub("1"), stub("2", { status: "in_progress" }), stub("3")])
    expect(survivor.id).toBe("2")
  })

  it("prefers the most recent activity when statuses match", () => {
    const survivor = selectSurvivor([
      stub("1", { statusChangedAt: "2026-01-01T00:00:00.000Z" }),
      stub("2", { statusChangedAt: "2026-06-01T00:00:00.000Z" }),
    ])
    expect(survivor.id).toBe("2")
  })

  it("falls back to the lowest id so identical stubs resolve deterministically", () => {
    // Numeric-aware collation compares the leading digit runs: 9 < 34 < 111.
    expect(selectSurvivor([stub("9f95-1"), stub("34e5-1"), stub("111c-1")]).id).toBe("9f95-1")
    // Same group, different input order — the choice must not depend on ordering.
    expect(selectSurvivor([stub("111c-1"), stub("34e5-1"), stub("9f95-1")]).id).toBe("9f95-1")
  })
})

describe("mergeGroup", () => {
  it("unions dependency edges from every duplicate onto the survivor", () => {
    const result = mergeGroup([
      stub("1", { status: "in_progress", blocks: ["a"], blockedBy: ["x"] }),
      stub("2", { blocks: ["b"], blockedBy: ["y"] }),
    ])

    expect(result.task.id).toBe("1")
    expect(result.mergedIds).toEqual(["2"])
    expect([...(result.task.blocks ?? [])].sort()).toEqual(["a", "b"])
    expect([...(result.task.blockedBy ?? [])].sort()).toEqual(["x", "y"])
  })

  it("drops edges that would dangle or self-reference after the merge", () => {
    const result = mergeGroup([
      stub("1", { status: "in_progress", blocks: ["2"], blockedBy: ["1"] }),
      stub("2", { blocks: ["keep"] }),
    ])

    // "2" was folded in and "1" is the survivor itself — neither may survive as an edge.
    expect(result.task.blocks).toEqual(["keep"])
    expect(result.task.blockedBy).toEqual([])
  })
})

describe("planDuplicateMerges", () => {
  it("collapses each same-subject group and leaves unique tasks untouched", () => {
    const tasks = [
      stub("1"),
      stub("2"),
      stub("3"),
      { id: "4", subject: "Commit uncommitted changes", status: "pending" },
      { id: "5", subject: "Commit uncommitted changes", status: "pending" },
      { id: "6", subject: "Investigate the OAuth return leg", status: "pending" },
    ]

    const { tasks: result, merges } = planDuplicateMerges(tasks)

    expect(result.map((t) => t.id)).toEqual(["1", "4", "6"])
    expect(merges.map((m) => m.mergedIds)).toEqual([["2", "3"], ["5"]])
  })

  it("matches subjects ignoring case and whitespace differences", () => {
    const { tasks: result } = planDuplicateMerges([
      stub("1", { subject: "Push branch to remote" }),
      stub("2", { subject: "  push   BRANCH to Remote " }),
    ])

    expect(result).toHaveLength(1)
  })

  // Control: without this, the collapse above could be passing by merging everything.
  it("never merges terminal records, which are history rather than open work", () => {
    const tasks = [
      stub("1", { status: "completed" }),
      stub("2", { status: "completed" }),
      stub("3", { status: "cancelled" }),
      stub("4", { status: "cancelled" }),
    ]

    const { tasks: result, merges } = planDuplicateMerges(tasks)

    expect(result.map((t) => t.id)).toEqual(["1", "2", "3", "4"])
    expect(merges).toEqual([])
  })

  it("leaves a single open task alone", () => {
    const { tasks: result, merges } = planDuplicateMerges([stub("1")])
    expect(result.map((t) => t.id)).toEqual(["1"])
    expect(merges).toEqual([])
  })
})

describe("mergeDuplicateTaskFiles", () => {
  it("deletes the folded-in files, keeps the survivor, and persists it", async () => {
    const dir = await makeStoreDir()
    const tasks = [stub("1"), stub("2"), stub("3")]
    for (const task of tasks) await writeTaskFile(dir, task)

    const written: string[] = []
    const surviving = await mergeDuplicateTaskFiles(dir, tasks, async (task) => {
      written.push(task.id)
    })

    expect(surviving.map((t) => t.id)).toEqual(["1"])
    expect(written).toEqual(["1"])
    expect(await fileExists(dir, "1")).toBe(true)
    expect(await fileExists(dir, "2")).toBe(false)
    expect(await fileExists(dir, "3")).toBe(false)
  })

  it("touches nothing when there are no duplicates", async () => {
    const dir = await makeStoreDir()
    const tasks = [stub("1"), { id: "2", subject: "Something else", status: "pending" }]
    for (const task of tasks) await writeTaskFile(dir, task)

    const written: string[] = []
    const surviving = await mergeDuplicateTaskFiles(dir, tasks, async (task) => {
      written.push(task.id)
    })

    expect(surviving.map((t) => t.id)).toEqual(["1", "2"])
    expect(written).toEqual([])
    expect(await fileExists(dir, "1")).toBe(true)
    expect(await fileExists(dir, "2")).toBe(true)
  })

  it("still drops a duplicate from the result when its file is already gone", async () => {
    const dir = await makeStoreDir()
    const tasks = [stub("1"), stub("2")]
    await writeTaskFile(dir, tasks[0] as MergeableTask)

    const surviving = await mergeDuplicateTaskFiles(dir, tasks)

    expect(surviving.map((t) => t.id)).toEqual(["1"])
  })

  it("keeps the in-memory result correct when persisting the survivor fails", async () => {
    const dir = await makeStoreDir()
    const tasks = [stub("1"), stub("2")]
    for (const task of tasks) await writeTaskFile(dir, task)

    const surviving = await mergeDuplicateTaskFiles(dir, tasks, async () => {
      throw new Error("disk full")
    })

    expect(surviving.map((t) => t.id)).toEqual(["1"])
    expect(await fileExists(dir, "2")).toBe(false)
  })
})
