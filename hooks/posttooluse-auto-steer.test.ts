import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getAutoSteerStore, resetAutoSteerStore } from "../src/auto-steer-store.ts"
import { acquireEnvLock, releaseEnvLockFn } from "../src/utils/test-utils.ts"
import { getTriggersToDeliver } from "./posttooluse-auto-steer.ts"

// In-process unit tests for the trigger-selection logic — no hook subprocess,
// no AppleScript send (getTriggersToDeliver only reads the queue + tool record).
//
// These tests point process.env.HOME at a temp dir so the auto-steer store
// resolves under an isolated root. That mutation is process-global, so the env
// lock serializes this file's HOME window against every other env-mutating test
// file running under `bun test --concurrent` (per the CLAUDE.md "no unguarded
// process.env.HOME mutation" rule; see issue #680).

const SESSION = "sess-task-triggers"
const tmpDirs: string[] = []
let originalHome: string | undefined

describe("posttooluse-auto-steer getTriggersToDeliver", () => {
  beforeEach(async () => {
    await acquireEnvLock()
    resetAutoSteerStore()
    originalHome = process.env.HOME
    const home = mkdtempSync(join(tmpdir(), "swiz-autosteer-trigger-"))
    tmpDirs.push(home)
    process.env.HOME = home
  })

  afterEach(async () => {
    try {
      resetAutoSteerStore()
      if (originalHome === undefined) delete process.env.HOME
      else process.env.HOME = originalHome
      for (const dir of tmpDirs) await rm(dir, { recursive: true, force: true })
      tmpDirs.length = 0
    } finally {
      releaseEnvLockFn()
    }
  })

  test("delivers task_created when the tool was a TaskCreate", async () => {
    const store = getAutoSteerStore()
    store.enqueue(SESSION, "review the new task", "task_created", { dedupKey: "review" })

    const triggers = await getTriggersToDeliver(
      store,
      SESSION,
      SESSION,
      { tool_name: "TaskCreate" },
      "apple-terminal"
    )

    expect(triggers).toEqual(["task_created"])
  })

  test("delivers task_updated when the tool was a TaskUpdate", async () => {
    const store = getAutoSteerStore()
    store.enqueue(SESSION, "keep the buffer healthy", "task_updated", { dedupKey: "buffer" })

    const triggers = await getTriggersToDeliver(
      store,
      SESSION,
      SESSION,
      { tool_name: "TaskUpdate", tool_input: { status: "in_progress" } },
      "apple-terminal"
    )

    expect(triggers).toEqual(["task_updated"])
  })

  test("delivers task_completed only when a TaskUpdate sets status to completed", async () => {
    const store = getAutoSteerStore()
    store.enqueue(SESSION, "pick the next task", "task_completed", { dedupKey: "next" })

    const notCompleted = await getTriggersToDeliver(
      store,
      SESSION,
      SESSION,
      { tool_name: "TaskUpdate", tool_input: { status: "in_progress" } },
      "apple-terminal"
    )
    expect(notCompleted).toEqual([])

    const completed = await getTriggersToDeliver(
      store,
      SESSION,
      SESSION,
      { tool_name: "TaskUpdate", tool_input: { status: "completed" } },
      "apple-terminal"
    )
    expect(completed).toEqual(["task_completed"])
  })

  test("returns no triggers when the terminal is not AppleScript-controllable", async () => {
    const store = getAutoSteerStore()
    store.enqueue(SESSION, "review the new task", "task_created", { dedupKey: "review" })

    const triggers = await getTriggersToDeliver(
      store,
      SESSION,
      SESSION,
      { tool_name: "TaskCreate" },
      "vscode"
    )

    expect(triggers).toEqual([])
  })
})
