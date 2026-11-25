import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, realpath, rm, symlink, unlink, utimes } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getGitClient } from "./git/client.ts"
import {
  captureEditSnapshot,
  editSnapshotStats,
  resetEditSnapshotCacheForTests,
} from "./session-edit-snapshot.ts"

const tempDirs: string[] = []

async function createRepo(files: Record<string, string>): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "swiz-edit-snapshot-")))
  tempDirs.push(dir)
  await getGitClient().run(["init", "-q"], { cwd: dir })
  for (const [name, content] of Object.entries(files)) await Bun.write(join(dir, name), content)
  return dir
}

function sha256(content: string): string {
  return new Bun.CryptoHasher("sha256").update(content).digest("hex")
}

describe("captureEditSnapshot", () => {
  beforeEach(resetEditSnapshotCacheForTests)

  afterAll(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  })

  test("fingerprints every worktree file by mode and content", async () => {
    const dir = await createRepo({ "a.txt": "alpha", "nested/b.txt": "beta" })
    const snapshot = await captureEditSnapshot(dir)

    expect(Object.keys(snapshot).sort()).toEqual([join(dir, "a.txt"), join(dir, "nested/b.txt")])
    expect(snapshot[join(dir, "a.txt")]).toEndWith(`:${sha256("alpha")}`)
    expect(snapshot[join(dir, "nested/b.txt")]).toEndWith(`:${sha256("beta")}`)
    expect(editSnapshotStats()).toEqual({ hashed: 2, reused: 0 })
  })

  test("an unchanged worktree is answered from memory, with identical fingerprints", async () => {
    const dir = await createRepo({ "a.txt": "alpha", "b.txt": "beta", "c.txt": "gamma" })
    const first = await captureEditSnapshot(dir)
    const second = await captureEditSnapshot(dir)

    expect(second).toEqual(first)
    // Control: the first pass really hashed, so "reused" below is not vacuous.
    expect(editSnapshotStats()).toEqual({ hashed: 3, reused: 3 })
  })

  test("re-reads only the file whose content changed", async () => {
    const dir = await createRepo({ "a.txt": "alpha", "b.txt": "beta" })
    const before = await captureEditSnapshot(dir)
    await Bun.write(join(dir, "a.txt"), "alpha, edited")
    const after = await captureEditSnapshot(dir)

    expect(after[join(dir, "a.txt")]).toEndWith(`:${sha256("alpha, edited")}`)
    expect(after[join(dir, "a.txt")]).not.toBe(before[join(dir, "a.txt")])
    expect(after[join(dir, "b.txt")]).toBe(before[join(dir, "b.txt")])
    expect(editSnapshotStats()).toEqual({ hashed: 3, reused: 1 })
  })

  test("detects a same-size rewrite through the modification time", async () => {
    const dir = await createRepo({ "a.txt": "alpha" })
    const before = await captureEditSnapshot(dir)
    await Bun.write(join(dir, "a.txt"), "omega")
    const later = new Date(Date.now() + 60_000)
    await utimes(join(dir, "a.txt"), later, later)
    const after = await captureEditSnapshot(dir)

    expect(after[join(dir, "a.txt")]).toEndWith(`:${sha256("omega")}`)
    expect(after[join(dir, "a.txt")]).not.toBe(before[join(dir, "a.txt")])
  })

  test("records a tracked file deleted from the worktree as absent", async () => {
    const dir = await createRepo({ "a.txt": "alpha", "gone.txt": "soon removed" })
    await getGitClient().run(["add", "--", "gone.txt"], { cwd: dir })
    await captureEditSnapshot(dir)
    await unlink(join(dir, "gone.txt"))
    const after = await captureEditSnapshot(dir)

    expect(after[join(dir, "gone.txt")]).toBeNull()
    expect(after[join(dir, "a.txt")]).toEndWith(`:${sha256("alpha")}`)
  })

  test("leaves out a link that resolves outside the worktree", async () => {
    const outside = await createRepo({ "secret.txt": "elsewhere" })
    const dir = await createRepo({ "a.txt": "alpha" })
    await symlink(join(outside, "secret.txt"), join(dir, "link.txt"))
    const snapshot = await captureEditSnapshot(dir)

    expect(Object.keys(snapshot)).toEqual([join(dir, "a.txt")])
  })
})
