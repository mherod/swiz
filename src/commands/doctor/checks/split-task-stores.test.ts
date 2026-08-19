import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { projectKeyFromCwd } from "../../../project-key.ts"
import { checkSplitTaskStores } from "./split-task-stores.ts"

const homes: string[] = []

afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true })
})

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "swiz-split-store-"))
  homes.push(home)
  return home
}

async function writeTask(
  home: string,
  storeKey: string,
  id: string,
  status: string
): Promise<void> {
  const dir = join(home, ".claude", "tasks", storeKey)
  await mkdir(dir, { recursive: true })
  await Bun.write(
    join(dir, `${id}.json`),
    JSON.stringify({ id, subject: `subject ${id}`, description: "", status })
  )
}

describe("checkSplitTaskStores", () => {
  const CWD = "/Users/someone/Development/demo"

  test("passes when the project-keyed store holds no tasks", async () => {
    const result = await checkSplitTaskStores(CWD, tempHome())
    expect(result.status).toBe("pass")
  })

  test("passes when the project-keyed store holds only finished tasks (control)", async () => {
    // Without this control the warn case below could fire on any task rather than open work.
    const home = tempHome()
    await writeTask(home, projectKeyFromCwd(CWD), "349d-1", "completed")
    await writeTask(home, projectKeyFromCwd(CWD), "349d-2", "cancelled")

    const result = await checkSplitTaskStores(CWD, home)
    expect(result.status).toBe("pass")
  })

  test("warns and names the open tasks held under the project key", async () => {
    const home = tempHome()
    await writeTask(home, projectKeyFromCwd(CWD), "349d-1", "pending")
    await writeTask(home, projectKeyFromCwd(CWD), "349d-2", "in_progress")
    await writeTask(home, projectKeyFromCwd(CWD), "349d-3", "completed")

    const result = await checkSplitTaskStores(CWD, home)
    expect(result.status).toBe("warn")
    expect(result.detail).toContain("2 open task(s)")
    expect(result.detail).toContain("#349d-1")
    expect(result.detail).toContain("#349d-2")
    expect(result.detail).not.toContain("#349d-3")
  })

  test("passes when no home directory is resolvable", async () => {
    const result = await checkSplitTaskStores(CWD, "")
    expect(result.status).toBe("pass")
  })
})
