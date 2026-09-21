import { describe, expect, it } from "bun:test"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { useTempDir } from "../utils/test-utils.ts"
import {
  type AddressedTask,
  type MergeableTask,
  mergeDuplicateTaskFiles,
  mergeDuplicateTasksAcrossStores,
  mergeGroup,
  planDuplicateMerges,
  selectSurvivor,
} from "./task-merge-duplicates.ts"
import { indexTasksById, openBlockersOf } from "./task-topology.ts"

const tmp = useTempDir("swiz-task-merge-")

async function makeStoreDir(): Promise<string> {
  return tmp.create()
}

async function writeTaskFile(dir: string, task: MergeableTask): Promise<void> {
  await Bun.write(join(dir, `${task.id}.json`), JSON.stringify(task))
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

  it("abandons the group intact when persisting the survivor fails", async () => {
    const dir = await makeStoreDir()
    const tasks = [stub("1"), stub("2")]
    for (const task of tasks) await writeTaskFile(dir, task)

    const surviving = await mergeDuplicateTaskFiles(dir, tasks, async () => {
      throw new Error("disk full")
    })

    // The survivor carries the union of both records' edges and that union is
    // now nowhere on disk, so deleting the duplicate would lose it for good.
    expect(surviving.map((t) => t.id)).toEqual(["1", "2"])
    expect(await fileExists(dir, "1")).toBe(true)
    expect(await fileExists(dir, "2")).toBe(true)
  })

  it("refuses to delete a record whose id escapes the store directory", async () => {
    const dir = join(await makeStoreDir(), "store")
    await mkdir(dir)
    const outside = join(dir, "..", "settings.json")
    await Bun.write(outside, JSON.stringify({ keep: true }))

    // Same subject, so grouping pairs them. in_progress makes the well-formed
    // record the survivor outright, so the traversal id is the one that would
    // be unlinked rather than whichever way a locale tie-break happens to fall.
    const tasks = [
      stub("1", { status: "in_progress" }),
      { ...stub("placeholder"), id: "../settings" },
    ]
    await writeTaskFile(dir, tasks[0] as MergeableTask)

    const surviving = await mergeDuplicateTaskFiles(dir, tasks, async () => {})

    expect(await Bun.file(outside).exists()).toBe(true)
    // The group is left whole rather than half-merged.
    expect(surviving.map((t) => t.id)).toEqual(["1", "../settings"])
  })
})

describe("mergeDuplicateTasksAcrossStores", () => {
  // The motivating population: one hook stub per prior session, each alone in
  // its own store. A per-directory pass sees a group of one everywhere and
  // collapses nothing, which is why this case needs its own merge path.
  async function makeTaskStores(tasks: readonly MergeableTask[]) {
    const stores = new Map<string, string>()
    for (const task of tasks) {
      const dir = await makeStoreDir()
      stores.set(task.id, dir)
      await writeTaskFile(dir, task)
    }
    return stores
  }

  function accessFor(stores: Map<string, string>, written: Array<[string, string]>) {
    return {
      dirFor: (address: string) => stores.get(address) as string,
      write: async (address: string, task: MergeableTask) => {
        written.push([address, task.id])
        await writeTaskFile(stores.get(address) as string, task)
      },
    }
  }

  it("collapses one stub per session store into a single survivor", async () => {
    const ids = ["2487-1", "3448-1", "5976-1", "7271-1", "a1ea-1"]
    const stores = await makeTaskStores(ids.map((id) => stub(id)))
    const records = ids.map((id) => ({ address: id, task: stub(id) }))
    const written: Array<[string, string]> = []

    const surviving = await mergeDuplicateTasksAcrossStores(records, accessFor(stores, written))

    expect(surviving).toHaveLength(1)
    const survivorId = surviving[0]?.task.id as string
    expect(ids).toContain(survivorId)
    // The survivor is rewritten to its own store, never relocated.
    expect(written).toEqual([[survivorId, survivorId]])

    for (const id of ids) {
      const dir = stores.get(id) as string
      expect(await fileExists(dir, id)).toBe(id === survivorId)
    }
  })

  it("leaves distinct subjects in separate stores untouched", async () => {
    // Control: proves the collapse above comes from matching subjects, not
    // merely from records sharing a queue.
    const stores = await makeTaskStores([stub("1"), stub("2")])
    const records = [
      { address: "1", task: stub("1") },
      { address: "2", task: { id: "2", subject: "Run the test suite", status: "pending" } },
    ]
    const written: Array<[string, string]> = []

    const surviving = await mergeDuplicateTasksAcrossStores(records, accessFor(stores, written))

    expect(surviving.map((r) => r.task.id)).toEqual(["1", "2"])
    expect(written).toEqual([])
    expect(await fileExists(stores.get("1") as string, "1")).toBe(true)
    expect(await fileExists(stores.get("2") as string, "2")).toBe(true)
  })

  it("repoints an outsider's blockedBy edge from the folded record to the survivor", async () => {
    const stores = await makeTaskStores([stub("1"), stub("2")])
    const outsiderDir = await makeStoreDir()
    const outsider = {
      id: "9",
      subject: "Ship the release",
      status: "pending",
      blockedBy: ["2"],
    }
    await writeTaskFile(outsiderDir, outsider)
    stores.set("9", outsiderDir)

    const records = [
      { address: "1", task: stub("1", { status: "in_progress" }) },
      { address: "2", task: stub("2") },
      { address: "9", task: outsider },
    ]
    const written: Array<[string, MergeableTask]> = []

    const surviving = await mergeDuplicateTasksAcrossStores(records, {
      dirFor: (address: string) => stores.get(address) as string,
      write: async (address: string, task: MergeableTask) => {
        written.push([address, task])
        await writeTaskFile(stores.get(address) as string, task)
      },
    })

    // "2" was folded into "1"; the outsider must now block on "1", not on an id
    // that no longer resolves — openBlockersOf drops unresolvable ids, which
    // would mark this task ready while the survivor is still open.
    const repointed = surviving.find((r) => r.task.id === "9")
    expect(repointed?.task.blockedBy).toEqual(["1"])
    expect(written).toContainEqual(["9", expect.objectContaining({ id: "9", blockedBy: ["1"] })])
  })

  it("leaves edges alone when they point at nothing that was folded", async () => {
    // Control: repointing must not rewrite unrelated dependency edges.
    const stores = await makeTaskStores([stub("1")])
    const outsiderDir = await makeStoreDir()
    const outsider = { id: "9", subject: "Ship the release", status: "pending", blockedBy: ["7"] }
    await writeTaskFile(outsiderDir, outsider)
    stores.set("9", outsiderDir)

    const records = [
      { address: "1", task: stub("1") },
      { address: "9", task: outsider },
    ]
    const written: Array<[string, string]> = []

    const surviving = await mergeDuplicateTasksAcrossStores(records, accessFor(stores, written))

    expect(surviving.find((r) => r.task.id === "9")?.task.blockedBy).toEqual(["7"])
    expect(written).toEqual([])
  })

  it("keeps every store's record when the survivor write fails", async () => {
    const ids = ["1", "2"]
    const stores = await makeTaskStores(ids.map((id) => stub(id)))
    const records = ids.map((id) => ({ address: id, task: stub(id) }))

    const surviving = await mergeDuplicateTasksAcrossStores(records, {
      dirFor: (address: string) => stores.get(address) as string,
      write: async () => {
        throw new Error("disk full")
      },
    })

    expect(surviving.map((r) => r.task.id)).toEqual(ids)
    for (const id of ids) expect(await fileExists(stores.get(id) as string, id)).toBe(true)
  })

  async function readRecords(stores: Map<string, string>) {
    const records: AddressedTask<MergeableTask, string>[] = []
    for (const [id, dir] of stores) {
      const file = Bun.file(join(dir, `${id}.json`))
      if (await file.exists()) records.push({ address: id, task: await file.json() })
    }
    return records
  }

  function expectBlocked(records: AddressedTask<MergeableTask, string>[], ids: string[]) {
    const tasks = records.map(({ task }) => ({ ...task, blockedBy: task.blockedBy ?? [] }))
    const byId = indexTasksById(tasks)
    for (const id of ids) {
      const task = byId.get(id)
      expect(task).toBeDefined()
      expect(openBlockersOf(task!, byId).length).toBeGreaterThan(0)
    }
  }

  it.each([
    ["1", false],
    ["9", false],
    ["10", false],
    ["9", true],
  ] as const)("preserves blockers when writing %s fails (after persistence: %s)", async (id, afterWrite) => {
    const tasks = [
      stub("1", { status: "in_progress", blocks: ["unrelated"], blockedBy: ["a"] }),
      stub("2", { blocks: ["9", "10"], blockedBy: ["b"] }),
      stub("9", { subject: "Deploy service", blockedBy: ["2"], blocks: ["untouched"] }),
      stub("10", { subject: "Check browser output", blockedBy: ["2"] }),
      stub("done", { status: "completed" }),
      stub("cancelled", { status: "cancelled" }),
    ]
    const stores = await makeTaskStores(tasks)
    const records = await readRecords(stores)
    const written: Array<[string, string]> = []
    const access = accessFor(stores, written)
    const failed = await mergeDuplicateTasksAcrossStores(records, {
      ...access,
      write: async (address, task) => {
        if (task.id === id && !afterWrite) throw new Error("disk full")
        await access.write(address, task)
        if (task.id === id) throw new Error("metadata write failed")
      },
    })

    expect(failed.map((record) => record.task.id)).toEqual(tasks.map((task) => task.id))
    expect(await fileExists(stores.get("2")!, "2")).toBe(true)
    expectBlocked(failed, ["9", "10"])
    const reloaded = await readRecords(stores)
    expectBlocked(reloaded, ["9", "10"])
    // A callback may throw after saving its file; either durable reference is safe.
    if (!afterWrite) expect(failed).toEqual(reloaded)

    const recovered = await mergeDuplicateTasksAcrossStores(reloaded, access)
    expect(recovered.map((record) => record.task.id)).toEqual(["1", "9", "10", "done", "cancelled"])
    expect(await fileExists(stores.get("2")!, "2")).toBe(false)
    expectBlocked(recovered, ["9", "10"])
    expect(await readRecords(stores)).toEqual(recovered)
    for (const dependent of recovered.filter((record) => ["9", "10"].includes(record.task.id))) {
      expect(dependent.task.blockedBy).toEqual(["1"])
    }
    expect(recovered[0]?.task.blocks).toEqual(["unrelated", "9", "10"])
    expect(recovered[0]?.task.blockedBy).toEqual(["a", "b"])
    expect(recovered.find((record) => record.task.id === "9")?.task.blocks).toEqual(["untouched"])
    for (const [address, taskId] of written) expect(address).toBe(taskId)
    for (const terminal of tasks.slice(-2)) {
      expect(recovered.find((record) => record.task.id === terminal.id)?.task).toEqual(terminal)
    }
  })

  it.each([
    "3",
    "9",
    null,
  ])("keeps linked groups recoverable when writer %s fails", async (failedId) => {
    const stores = await makeTaskStores([
      stub("1", { status: "in_progress", blockedBy: ["4", "unrelated"] }),
      stub("2"),
      stub("3", { subject: "Commit changes", status: "in_progress" }),
      stub("4", { subject: "Commit changes", blocks: ["2"] }),
      stub("9", { subject: "Deploy release", blockedBy: ["2", "4"], blocks: ["untouched"] }),
    ])
    const records = await readRecords(stores)
    const access = accessFor(stores, [])
    const result = await mergeDuplicateTasksAcrossStores(records, {
      ...access,
      write: async (address, task) => {
        // Every required write precedes every deletion, including another group's.
        expect(await fileExists(stores.get("2")!, "2")).toBe(true)
        expect(await fileExists(stores.get("4")!, "4")).toBe(true)
        if (task.id === failedId) throw new Error("store unavailable")
        await access.write(address, task)
      },
    })
    expectBlocked(result, ["1", "9"])
    expectBlocked(await readRecords(stores), ["1", "9"])
    if (failedId !== null) {
      expect(result.map((record) => record.task.id)).toEqual(["1", "2", "3", "4", "9"])
      expect(await fileExists(stores.get("2")!, "2")).toBe(true)
      expect(await fileExists(stores.get("4")!, "4")).toBe(true)
    }
    const recovered = await mergeDuplicateTasksAcrossStores(await readRecords(stores), access)
    expect(recovered.map((record) => record.task.id)).toEqual(["1", "3", "9"])
    expect(recovered[0]?.task.blockedBy).toEqual(["3", "unrelated"])
    expect(recovered[1]?.task.blocks).toEqual(["1"])
    expect(recovered[2]?.task.blockedBy).toEqual(["1", "3"])
    expect(recovered[2]?.task.blocks).toEqual(["untouched"])
    expect(await readRecords(stores)).toEqual(recovered)
    expect(await fileExists(stores.get("2")!, "2")).toBe(false)
    expect(await fileExists(stores.get("4")!, "4")).toBe(false)
  })

  it("leaves a corrupt cross-store group intact without touching an outside file", async () => {
    const parent = await makeStoreDir()
    const dir = join(parent, "store")
    await mkdir(dir)
    const outside = join(parent, "settings.json")
    await Bun.write(outside, JSON.stringify({ keep: true }))
    const records = [
      { address: dir, task: stub("1", { status: "in_progress" }) },
      { address: dir, task: stub("../settings") },
    ]
    await writeTaskFile(dir, records[0]!.task)
    const writes: string[] = []
    const result = await mergeDuplicateTasksAcrossStores(records, {
      dirFor: (address) => address,
      write: async (_address, task) => {
        writes.push(task.id)
      },
    })
    expect(result).toEqual(records)
    expect(writes).toEqual([])
    expect(await Bun.file(outside).json()).toEqual({ keep: true })
    expect(await fileExists(dir, "1")).toBe(true)
  })
})
