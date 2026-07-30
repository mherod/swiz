import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getCanonicalPathHash } from "./git-helpers.ts"
import {
  canonicalizePath,
  isPathWithinRoot,
  resolveProjectIdentity,
  resolveProjectRoot,
} from "./project-identity.ts"

async function createTempTree(): Promise<{ base: string; cleanup: () => Promise<void> }> {
  const base = await mkdtemp(join(tmpdir(), "swiz-identity-unit-"))
  return { base, cleanup: () => rm(base, { recursive: true, force: true }) }
}

describe("canonicalizePath", () => {
  test("strips trailing slashes without collapsing the filesystem root", () => {
    expect(canonicalizePath("/nonexistent/project/")).toBe("/nonexistent/project")
    expect(canonicalizePath("/nonexistent/project///")).toBe("/nonexistent/project")
    expect(canonicalizePath("/")).toBe("/")
  })

  test("falls back to the trimmed input when the path is not on disk", () => {
    expect(canonicalizePath("/virtual/fork")).toBe("/virtual/fork")
  })

  test("resolves symlink aliases to the same value as the real path", async () => {
    const tree = await createTempTree()
    try {
      const real = join(tree.base, "repo")
      const alias = join(tree.base, "alias")
      await mkdir(real, { recursive: true })
      await symlink(real, alias)

      expect(canonicalizePath(alias)).toBe(canonicalizePath(real))
      expect(canonicalizePath(`${alias}/`)).toBe(canonicalizePath(real))
    } finally {
      await tree.cleanup()
    }
  })
})

describe("isPathWithinRoot", () => {
  test("matches the root itself and paths inside it", () => {
    expect(isPathWithinRoot("/repo", "/repo")).toBe(true)
    expect(isPathWithinRoot("/repo/", "/repo")).toBe(true)
    expect(isPathWithinRoot("/repo/src/nested", "/repo")).toBe(true)
    expect(isPathWithinRoot("/repo/src", "/repo/")).toBe(true)
  })

  test("rejects a sibling that merely shares a string prefix", () => {
    // The bare startsWith this replaces treated these as the same project.
    expect(isPathWithinRoot("/repo-backup", "/repo")).toBe(false)
    expect(isPathWithinRoot("/repository/src", "/repo")).toBe(false)
  })

  test("treats the filesystem root as containing everything", () => {
    expect(isPathWithinRoot("/anything/at/all", "/")).toBe(true)
  })
})

describe("resolveProjectRoot", () => {
  test("resolves any cwd inside a repo to the directory holding .git", async () => {
    const tree = await createTempTree()
    try {
      const root = join(tree.base, "repo")
      await mkdir(join(root, ".git"), { recursive: true })
      await mkdir(join(root, "src", "nested"), { recursive: true })

      const expected = canonicalizePath(root)
      expect(await resolveProjectRoot(root)).toBe(expected)
      expect(await resolveProjectRoot(`${root}/`)).toBe(expected)
      expect(await resolveProjectRoot(join(root, "src", "nested"))).toBe(expected)
    } finally {
      await tree.cleanup()
    }
  })

  test("returns the canonical cwd when it is not inside a repo", async () => {
    const tree = await createTempTree()
    try {
      const plain = join(tree.base, "plain")
      await mkdir(plain, { recursive: true })

      expect(await resolveProjectRoot(plain)).toBe(canonicalizePath(plain))
    } finally {
      await tree.cleanup()
    }
  })
})

describe("resolveProjectIdentity", () => {
  test("pairs the canonical root with the hash hook sentinels key on", async () => {
    const tree = await createTempTree()
    try {
      const root = join(tree.base, "repo")
      await mkdir(join(root, ".git"), { recursive: true })
      await mkdir(join(root, "src"), { recursive: true })

      const fromRoot = await resolveProjectIdentity(root)
      const fromSubdir = await resolveProjectIdentity(join(root, "src"))

      expect(fromRoot.canonicalRoot).toBe(canonicalizePath(root))
      expect(fromRoot.repoKey).toBe(getCanonicalPathHash(fromRoot.canonicalRoot))
      expect(fromSubdir).toEqual(fromRoot)
    } finally {
      await tree.cleanup()
    }
  })
})
