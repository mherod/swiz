import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { projectKeyFromCwd } from "../project-key.ts"
import { acquireEnvLock, releaseEnvLockFn, writeRawTaskFixture } from "../utils/test-utils.ts"
import { runTasks } from "./tasks.ts"

// Project listings now union owned stores. Preserve #826's visibility guarantee by checking
// that neither session is silently omitted or misrepresented as the selected one.

const roots: string[] = []

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop()
    if (root) await rm(root, { recursive: true, force: true })
  }
})

/** Serialize around process.env.HOME mutation — concurrent writers bleed across files (#680). */
async function serial<T>(fn: () => Promise<T>): Promise<T> {
  await acquireEnvLock()
  try {
    return await fn()
  } finally {
    releaseEnvLockFn()
  }
}

async function makeHome(): Promise<{ home: string; cwd: string }> {
  const root = join(tmpdir(), `swiz-notice-${process.pid}-${roots.length}-${Math.random()}`)
  roots.push(root)
  const cwd = join(root, "project")
  await mkdir(cwd, { recursive: true })
  await mkdir(join(root, ".claude", "tasks"), { recursive: true })
  await mkdir(join(root, ".claude", "projects"), { recursive: true })
  return { home: root, cwd }
}

async function seedStore(home: string, storeKey: string, cwd: string, taskId: string) {
  const dir = join(home, ".claude", "tasks", storeKey)
  // This fixture deliberately covers legacy flat project stores without storeKind metadata.
  await writeRawTaskFixture(home, storeKey, {
    id: taskId,
    subject: `subject ${taskId}`,
    description: "d",
    status: "pending",
    blocks: [],
    blockedBy: [],
  })
  await writeFile(
    join(dir, ".session-meta.json"),
    JSON.stringify({ openCount: 1, updatedAt: new Date().toISOString(), cwd })
  )
}

// `swiz tasks` refuses to list inside a task-capable agent, so these must be absent for the CLI
// path to run at all. The suite inherits them from whatever agent invoked the test run.
const AGENT_DETECTION_VARS = [
  "CLAUDECODE",
  "GEMINI_CLI",
  "GEMINI_PROJECT_DIR",
  "CODEX_MANAGED_BY_NPM",
  "CODEX_THREAD_ID",
] as const

/** Run the task listing with HOME pointed at the fixture, capturing what it printed. */
async function listOutput(home: string, cwd: string): Promise<string> {
  const saved = new Map<string, string | undefined>()
  const set = (key: string, value: string | undefined) => {
    if (!saved.has(key)) saved.set(key, process.env[key])
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }

  const logs: string[] = []
  const origLog = console.log
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "))
  set("HOME", home)
  set("SWIZ_TASKS_SYSTEM_MESSAGE", "0")
  for (const key of AGENT_DETECTION_VARS) set(key, undefined)

  try {
    await runTasks([], cwd)
  } finally {
    console.log = origLog
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
  return logs.join("\n")
}

describe("swiz tasks session-selection notice", () => {
  test("prints a task listing at all (control)", async () => {
    // Without this control, an empty-output regression would make the silence assertion below
    // pass for the wrong reason.
    await serial(async () => {
      const { home, cwd } = await makeHome()
      await seedStore(home, projectKeyFromCwd(cwd), cwd, "user-1")
      expect(await listOutput(home, cwd)).toContain("user-1")
    })
  })

  test("shows all owned sessions without claiming to select only the newest", async () => {
    await serial(async () => {
      const { home, cwd } = await makeHome()
      await seedStore(home, projectKeyFromCwd(cwd), cwd, "user-1")
      await seedStore(home, "00000000-0000-0000-0000-0000000000a1", cwd, "a1-1")

      const output = await listOutput(home, cwd)
      expect(output).toContain("user-1")
      expect(output).toContain("a1-1")
      expect(output).toContain("2/2 incomplete")
      expect(output).not.toContain("Showing most recently updated")
    })
  })

  test("stays quiet when only one session could have answered", async () => {
    await serial(async () => {
      const { home, cwd } = await makeHome()
      await seedStore(home, projectKeyFromCwd(cwd), cwd, "user-1")
      expect(await listOutput(home, cwd)).not.toContain("Showing most recently updated")
    })
  })
})
