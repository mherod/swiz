import { describe, expect, it, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { git } from "./git-helpers.ts"
import {
  extractDeletionTargets,
  findStagedPaths,
  formatStagedPathDenial,
  isDeliberatelyStaged,
  readPathStatus,
} from "./peer-staged-paths.ts"

describe("extractDeletionTargets", () => {
  test("trash with one path", () => {
    expect(extractDeletionTargets("trash app/favicon.ico")).toEqual(["app/favicon.ico"])
  })

  test("trash with several paths", () => {
    expect(extractDeletionTargets("trash a.txt b.txt")).toEqual(["a.txt", "b.txt"])
  })

  test("git rm --cached drops the flag and keeps the path", () => {
    expect(extractDeletionTargets("git rm --cached app/favicon.ico")).toEqual(["app/favicon.ico"])
  })

  test("git rm with -C global option", () => {
    expect(extractDeletionTargets("git -C /repo rm --cached x.ico")).toEqual(["x.ico"])
  })

  test("quoted path with brackets survives tokenizing", () => {
    expect(extractDeletionTargets(`trash "app/[lang]/toolkit/page.tsx"`)).toEqual([
      "app/[lang]/toolkit/page.tsx",
    ])
  })

  test("both halves of the real incident, chained", () => {
    expect(
      extractDeletionTargets("trash app/favicon.ico && git rm --cached app/favicon.ico")
    ).toEqual(["app/favicon.ico", "app/favicon.ico"])
  })

  test("the -- separator is not treated as a path", () => {
    expect(extractDeletionTargets("git rm -- a.txt")).toEqual(["a.txt"])
  })

  test("unrelated commands yield nothing", () => {
    expect(extractDeletionTargets("git status --short")).toEqual([])
    expect(extractDeletionTargets("bun test")).toEqual([])
  })

  test("git add is not a deletion", () => {
    expect(extractDeletionTargets("git add app/favicon.ico")).toEqual([])
  })
})

describe("isDeliberatelyStaged", () => {
  test("AD — staged then removed from the worktree, the incident's exact state", () => {
    expect(isDeliberatelyStaged("AD")).toBe(true)
  })

  test("A with a clean worktree column", () => {
    expect(isDeliberatelyStaged("A ")).toBe(true)
  })

  test("untracked is the one genuinely open case", () => {
    expect(isDeliberatelyStaged("??")).toBe(false)
  })

  test("unstaged modification is not a deliberate stage", () => {
    expect(isDeliberatelyStaged(" M")).toBe(false)
  })

  test("worktree deletion without staging", () => {
    expect(isDeliberatelyStaged(" D")).toBe(false)
  })
})

describe("findStagedPaths against a real repository", () => {
  async function withRepo<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), "staged-paths-"))
    try {
      await git(["init"], dir)
      await git(["config", "user.email", "test@swiz.local"], dir)
      await git(["config", "user.name", "Swiz Test"], dir)
      return await fn(dir)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  it("finds a staged new file", async () => {
    await withRepo(async (dir) => {
      await writeFile(join(dir, "favicon.ico"), "binary-ish")
      await git(["add", "favicon.ico"], dir)
      const found = await findStagedPaths(["favicon.ico"], dir)
      expect(found).toHaveLength(1)
      expect(found[0]?.status.charAt(0)).toBe("A")
    })
  })

  it("still finds it once the working copy has been trashed (the AD state)", async () => {
    await withRepo(async (dir) => {
      await writeFile(join(dir, "favicon.ico"), "binary-ish")
      await git(["add", "favicon.ico"], dir)
      await rm(join(dir, "favicon.ico"))
      const found = await findStagedPaths(["favicon.ico"], dir)
      expect(found[0]?.status).toBe("AD")
    })
  })

  // Control: the repository helper and path plumbing above must be capable of returning nothing,
  // otherwise the untracked assertion below could pass for reasons unrelated to staging.
  it("reports nothing for an untracked file", async () => {
    await withRepo(async (dir) => {
      await writeFile(join(dir, "scratch.log"), "noise")
      expect(await findStagedPaths(["scratch.log"], dir)).toEqual([])
    })
  })

  it("reports nothing for a path that does not exist", async () => {
    await withRepo(async (dir) => {
      expect(await findStagedPaths(["nope.txt"], dir)).toEqual([])
    })
  })

  it("returns null status outside a git repository rather than blocking", async () => {
    const dir = await mkdtemp(join(tmpdir(), "staged-paths-nogit-"))
    try {
      expect(await readPathStatus("anything.txt", dir)).toBeNull()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("formatStagedPathDenial", () => {
  it("names the path, its status, and the provenance order", () => {
    const text = formatStagedPathDenial([{ path: "app/favicon.ico", status: "AD" }])
    expect(text).toContain("BLOCKED")
    expect(text).toContain("app/favicon.ico")
    expect(text).toContain("AD")
    expect(text).toContain("git status --short")
    expect(text).toContain("Ask the peer")
  })

  it("pluralises for several paths", () => {
    const text = formatStagedPathDenial([
      { path: "a", status: "A " },
      { path: "b", status: "A " },
    ])
    expect(text).toContain("These paths are")
  })
})
