import { describe, expect, test } from "bun:test"
import { mkdir, readdir, symlink } from "node:fs/promises"
import { join } from "node:path"
import { runMemoryMigration } from "./commands/memory-migrate.ts"
import {
  inventoryMemories,
  type MemoryMigration,
  memoryDigest,
  migrateMemories,
} from "./memory-migration.ts"
import { canonicalizePath } from "./project-identity.ts"
import { resolveProjectMemory } from "./project-memory.ts"
import { getProviderAdapter } from "./provider-adapters.ts"
import { useTempDir } from "./utils/test-utils.ts"

const { create } = useTempDir("memory-migration-")

// Repository topology is fixture data. No Git, Codex or network calls are needed.
async function fixture() {
  const directory = canonicalizePath(await create())
  const repository = join(directory, "project")
  await mkdir(join(repository, ".git"), { recursive: true })
  const source = join(directory, "external", "note.md")
  await Bun.write(source, "Original project guidance\n")
  const plan = await inventoryMemories(join(directory, "external"))
  plan.hostPolicyResolved = true
  plan.records[0]!.targets = [
    { repository, kind: "note", content: "Retained guidance", reviewed: true },
  ]
  return { directory, repository, source, plan }
}

async function outcome(plan: MemoryMigration, mode: "plan" | "apply" | "verify" = "apply") {
  return (await migrateMemories(plan, mode))[0]!
}

describe("repository memory migration", () => {
  test("inventory defaults to unresolved ownership without copying contents into the manifest", async () => {
    const { directory, source } = await fixture()
    const plan = await inventoryMemories(join(directory, "external"))
    expect(plan.records).toEqual([
      { source, sha256: memoryDigest("Original project guidance\n"), targets: [] },
    ])
    expect(plan.hostPolicyResolved).toBe(false)
    expect(JSON.stringify(plan)).not.toContain("Original project guidance")
    expect((await outcome(plan)).status).toBe("unresolved")
  })

  test("dry run does not create files or copy receipts", async () => {
    const { repository, plan } = await fixture()
    expect((await outcome(plan, "plan")).status).toBe("planned")
    expect(await readdir(repository)).toEqual([".git"])
    expect(plan.records[0]!.copiedTargets).toBeUndefined()
  })

  test("copies with provenance and portable lookup while preserving the source", async () => {
    const { repository, plan, source } = await fixture()
    expect((await outcome(plan)).status).toBe("copied")
    expect(await Bun.file(source).text()).toBe("Original project guidance\n")
    const index = await Bun.file(join(repository, ".swiz/memory/MEMORY.md")).text()
    expect(index).toContain(plan.records[0]!.sha256)
    expect(index).not.toContain(source)
    expect(await Bun.file(join(repository, "AGENTS.md")).text()).toContain(".swiz/memory/MEMORY.md")
    expect(await Bun.file(join(repository, ".cursorrules")).text()).toContain(
      ".swiz/memory/MEMORY.md"
    )
    expect(await Bun.file(join(repository, "GEMINI.md")).text()).toContain(".swiz/memory/MEMORY.md")
    expect(await Bun.file(join(repository, ".gemini/GEMINI.md")).text()).toContain(
      "../.swiz/memory/MEMORY.md"
    )
    expect((await outcome(plan, "verify")).status).toBe("copied")
  })

  test("deduplicates repeat runs and overlapping source content", async () => {
    const { repository, plan, directory } = await fixture()
    await outcome(plan)
    const original = await Bun.file(join(repository, "CLAUDE.md")).text()
    await outcome(plan)
    expect(await Bun.file(join(repository, "CLAUDE.md")).text()).toBe(original)
    const source = join(directory, "external", "overlap.md")
    await Bun.write(source, "Other provenance")
    plan.records.push({
      source,
      sha256: memoryDigest("Other provenance"),
      targets: plan.records[0]!.targets,
    })
    expect(
      (await migrateMemories(plan, "apply")).every((result) => result.status === "copied")
    ).toBe(true)
    const files = await readdir(join(repository, ".swiz/memory"))
    expect(files.length).toBe(2)
  })

  test("writes durable rules to the nearest in-repository CLAUDE.md", async () => {
    const { repository, plan } = await fixture()
    const scope = join(repository, "packages", "one")
    await Bun.write(join(scope, "CLAUDE.md"), "# Scoped rules\n")
    await mkdir(join(scope, "src"))
    plan.records[0]!.targets[0] = {
      repository: join(scope, "src"),
      kind: "rule",
      content: "DO: preserve scoped behavior.",
      reviewed: true,
    }
    expect((await outcome(plan)).status).toBe("copied")
    expect(await Bun.file(join(scope, "CLAUDE.md")).text()).toContain(
      "DO: preserve scoped behavior."
    )
    expect(await Bun.file(join(repository, "CLAUDE.md")).text()).not.toContain(
      "DO: preserve scoped behavior."
    )
  })

  test("keeps linked-worktree memory in that checkout", async () => {
    const { repository, plan, directory } = await fixture()
    const worktree = join(directory, "worktree")
    await Bun.write(join(worktree, ".git"), `gitdir: ${repository}/.git/worktrees/example\n`)
    plan.records[0]!.targets[0]!.repository = worktree
    expect((await outcome(plan)).status).toBe("copied")
    expect((await resolveProjectMemory(worktree))?.root).toBe(worktree)
    expect(await Bun.file(join(repository, "CLAUDE.md")).exists()).toBe(false)
  })

  test("splits a mixed record across explicitly mapped repositories", async () => {
    const { repository, plan, directory } = await fixture()
    const other = join(directory, "other")
    await mkdir(join(other, ".git"), { recursive: true })
    plan.records[0]!.targets.push({
      repository: other,
      kind: "dated",
      content: "2026-09-11: older result; recheck.",
      reviewed: true,
    })
    expect((await outcome(plan)).status).toBe("copied")
    const otherFiles = await readdir(join(other, ".swiz/memory"))
    const note = await Bun.file(
      join(other, ".swiz/memory", otherFiles.find((file) => file !== "MEMORY.md")!)
    ).text()
    expect(note).toContain("Dated context (verify before reuse)")
    expect(note).not.toContain("Retained guidance")
    expect(await Bun.file(join(repository, ".swiz/memory/MEMORY.md")).text()).not.toContain(
      "2026-09-11"
    )
  })

  test.each([
    "host",
    "ownership",
    "review",
  ])("does not write before resolving %s", async (missing) => {
    const { repository, plan } = await fixture()
    if (missing === "host") plan.hostPolicyResolved = false
    if (missing === "ownership") plan.records[0]!.targets = []
    if (missing === "review") plan.records[0]!.targets[0]!.reviewed = false
    expect((await outcome(plan)).status).toBe("unresolved")
    expect(await readdir(repository)).toEqual([".git"])
  })

  test("fails changed or missing sources without writing", async () => {
    const { source, plan, repository } = await fixture()
    await Bun.write(source, "Changed")
    expect((await outcome(plan)).detail).toContain("Source changed")
    await Bun.file(source).delete()
    expect((await outcome(plan)).detail).toContain("Source missing")
    expect(await readdir(repository)).toEqual([".git"])
  })

  test("refuses destination conflicts and detects missing lookup links", async () => {
    const { plan, repository } = await fixture()
    await outcome(plan)
    const directory = join(repository, ".swiz/memory")
    const note = (await readdir(directory)).find((file) => file !== "MEMORY.md")!
    await Bun.write(join(directory, note), "User edit")
    expect((await outcome(plan)).status).toBe("failed")
    expect(await Bun.file(join(directory, note)).text()).toBe("User edit")
    await Bun.write(join(repository, "AGENTS.md"), "Lookup removed")
    expect((await outcome(plan, "verify")).status).toBe("failed")
  })

  test("reports migrated only after verified copying, fresh-session lookup and retirement", async () => {
    const { plan, source } = await fixture()
    await outcome(plan)
    await Bun.file(source).delete() // Simulate explicit operator retirement of a test fixture.
    expect((await outcome(plan, "verify")).status).toBe("copied")
    plan.lookupVerified = true
    expect((await outcome(plan, "verify")).status).toBe("migrated")
    plan.records[0]!.targets[0]!.content = "Changed after retirement"
    expect((await outcome(plan, "verify")).status).toBe("failed")
  })

  test("rejects symlink destination escapes", async () => {
    const { plan, repository, directory } = await fixture()
    const outside = join(directory, "outside")
    await mkdir(outside)
    await symlink(outside, join(repository, ".swiz"))
    expect((await outcome(plan)).status).toBe("failed")
    expect(await readdir(outside)).toEqual([])
  })

  test("rejects unmigrated local references while retaining remote references", async () => {
    const { plan } = await fixture()
    plan.records[0]!.targets[0]!.content = "See [memory](../../../external/note.md)."
    expect((await outcome(plan)).status).toBe("failed")
    plan.records[0]!.targets[0]!.content = "See [reference](https://example.com/reference)."
    expect((await outcome(plan)).status).toBe("copied")
  })

  test("rejects unmigrated reference-style Markdown links", async () => {
    const { plan } = await fixture()
    plan.records[0]!.targets[0]!.content =
      "See [memory][source].\n\n[source]: ../../../external/note.md"
    expect((await outcome(plan)).status).toBe("failed")
  })

  test("preserves existing leading whitespace when appending lookup guidance", async () => {
    const { plan, repository } = await fixture()
    await Bun.write(join(repository, "CLAUDE.md"), "    indented content\n")
    expect((await outcome(plan)).status).toBe("copied")
    expect(await Bun.file(join(repository, "CLAUDE.md")).text()).toStartWith(
      "    indented content\n"
    )
  })

  test("provider readback uses repository memory for every agent", async () => {
    const { plan, repository } = await fixture()
    await outcome(plan)
    for (const provider of ["codex", "claude", "cursor", "gemini"]) {
      const sources = await getProviderAdapter(provider)!.getMemorySources(repository)
      const memories = sources.filter((source) => source.label.startsWith("Project memory"))
      expect(memories.length).toBe(2)
      expect(memories.every((source) => source.path.startsWith(repository))).toBe(true)
      expect(sources[0]!.path).toBe(join(repository, "CLAUDE.md"))
    }
  })

  test("CLI preserves inventory and receipts and rejects ambiguous flags", async () => {
    const { directory, plan } = await fixture()
    const manifest = join(directory, "private-plan.json")
    await Bun.write(manifest, JSON.stringify(plan))
    const result = JSON.parse(await runMemoryMigration(["--manifest", manifest, "--apply"]))
    expect(result.counts).toEqual({ planned: 0, copied: 1, migrated: 0, unresolved: 0, failed: 0 })
    expect((await Bun.file(manifest).json()).records[0].copiedTargets).toBeString()
    expect(await Bun.file(`${manifest}.bak`).text()).toBe(JSON.stringify(plan))
    await expect(
      runMemoryMigration(["--manifest", manifest, "--apply", "--verify"])
    ).rejects.toThrow("either")
    await expect(
      runMemoryMigration(["--source", join(directory, "external"), "--manifest", manifest])
    ).rejects.toThrow("already exists")
  })

  test("rejects manifests inside a destination repository", async () => {
    const { plan, repository } = await fixture()
    const manifest = join(repository, "private-plan.json")
    await Bun.write(manifest, JSON.stringify(plan))
    await expect(runMemoryMigration(["--manifest", manifest, "--apply"])).rejects.toThrow(
      "outside a Git repository"
    )
  })
})
