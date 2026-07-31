import { describe, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { canonicalizePath } from "./project-identity.ts"
import { resolveRepositoryCapability } from "./repository-capability.ts"
import { useTempDir } from "./utils/test-utils.ts"

const tempDirs = useTempDir("swiz-repository-capability-")

describe("resolveRepositoryCapability", () => {
  test("uses filesystem membership and performs one slug lookup for a repository", async () => {
    const root = await tempDirs.create()
    await mkdir(join(root, ".git"), { recursive: true })
    await mkdir(join(root, "src"), { recursive: true })
    let slugLookups = 0

    const capability = await resolveRepositoryCapability(join(root, "src"), async (cwd) => {
      slugLookups++
      expect(cwd).toBe(canonicalizePath(root))
      return "owner/repo"
    })

    expect(capability).toEqual({
      canonicalRoot: canonicalizePath(root),
      repoKey: expect.any(String),
      isGitRepo: true,
      repoSlug: "owner/repo",
    })
    expect(slugLookups).toBe(1)
  })

  test("does not query a slug for a non-repository directory", async () => {
    const root = await tempDirs.create()
    let slugLookups = 0

    const capability = await resolveRepositoryCapability(root, async () => {
      slugLookups++
      return "owner/repo"
    })

    expect(capability.isGitRepo).toBe(false)
    expect(capability.repoSlug).toBeNull()
    expect(slugLookups).toBe(0)
  })

  test("retains verified membership when origin resolution fails", async () => {
    const root = await tempDirs.create()
    await mkdir(join(root, ".git"), { recursive: true })

    const capability = await resolveRepositoryCapability(root, async () => {
      throw new Error("origin unavailable")
    })

    expect(capability.isGitRepo).toBe(true)
    expect(capability.repoSlug).toBeNull()
  })
})
