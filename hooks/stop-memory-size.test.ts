import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as home from "../src/home.ts"
import { USE_COMPACT_MEMORY_SKILL } from "../src/memory-compaction-guidance.ts"
import * as repository from "../src/repository-capability.ts"
import { stopHookOutputSchema } from "../src/schemas.ts"
import * as skills from "../src/skill-utils.ts"
import * as memorySize from "./posttooluse-memory-size.ts"
import { evaluateStopMemorySize, indexPath, loadIndex, saveIndex } from "./stop-memory-size.ts"

afterEach(() => mock.restore())

// ── Helpers ───────────────────────────────────────────────────────────────────

async function withTmpDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = join(
    tmpdir(),
    `stop-memory-size-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  )
  await mkdir(dir, { recursive: true })
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe("stop guidance", () => {
  for (const installed of [true, false]) {
    test(`preserves compaction rules with the Skill ${installed ? "installed" : "missing"}`, () =>
      withTmpDir(async (cwd) => {
        spyOn(repository, "isGitRepoForHookPayload").mockResolvedValue(true)
        spyOn(home, "getHomeDirWithFallback").mockReturnValue(cwd)
        spyOn(memorySize, "resolveThresholds").mockResolvedValue({
          lineThreshold: 450,
          wordThreshold: 2,
        })
        spyOn(skills, "skillAdvice").mockImplementation((_skill, withSkill, withoutSkill) =>
          installed ? `${withSkill}\n\n${withoutSkill}` : withoutSkill
        )
        const filePath = join(cwd, "MEMORY.md")
        await Bun.write(filePath, "Keep these technical details.\n")

        const output = stopHookOutputSchema.parse(
          await evaluateStopMemorySize({ cwd, session_id: "memory-guidance" })
        )
        expect(output.decision).toBe("block")
        expect(output.reason).toContain(filePath)
        expect(output.reason).toContain("4 words (threshold: 2)")
        expect(output.reason).toContain("Compact each file manually:")
        expect(output.reason).toContain("Preserve all technical specifics:")
        expect(output.reason).toContain("`wc -l <file>` and `wc -w <file>`")
        expect(output.reason).not.toContain("swiz ")
        expect(output.reason?.includes(USE_COMPACT_MEMORY_SKILL)).toBe(installed)
      }))
  }
})

// ── indexPath ─────────────────────────────────────────────────────────────────

describe("indexPath", () => {
  test("returns .swiz/memory-index.json under cwd", () => {
    expect(indexPath("/some/project")).toBe("/some/project/.swiz/memory-index.json")
  })
})

// ── loadIndex ─────────────────────────────────────────────────────────────────

describe("loadIndex", () => {
  test("returns empty object when index does not exist", () =>
    withTmpDir(async (tmpDir) => {
      const result = await loadIndex(tmpDir)
      expect(result).toEqual({})
    }))

  test("returns empty object when index contains invalid JSON", () =>
    withTmpDir(async (tmpDir) => {
      await mkdir(join(tmpDir, ".swiz"), { recursive: true })
      await writeFile(join(tmpDir, ".swiz", "memory-index.json"), "not json")
      const result = await loadIndex(tmpDir)
      expect(result).toEqual({})
    }))

  test("returns parsed index when file is valid", () =>
    withTmpDir(async (tmpDir) => {
      const entry = { mtime: 1000, size: 42, lines: 10, words: 100 }
      const data = { "/some/file.md": entry }
      await mkdir(join(tmpDir, ".swiz"), { recursive: true })
      await writeFile(join(tmpDir, ".swiz", "memory-index.json"), JSON.stringify(data))
      const result = await loadIndex(tmpDir)
      expect(result).toEqual(data)
    }))
})

// ── saveIndex / loadIndex round-trip ─────────────────────────────────────────

describe("saveIndex", () => {
  test("persists index and loadIndex retrieves it", () =>
    withTmpDir(async (tmpDir) => {
      const entry = { mtime: 999, size: 55, lines: 20, words: 200 }
      const data = { "/path/to/CLAUDE.md": entry }
      await saveIndex(tmpDir, data)
      const result = await loadIndex(tmpDir)
      expect(result).toEqual(data)
    }))

  test("creates .swiz directory if missing", () =>
    withTmpDir(async (tmpDir) => {
      const entry = { mtime: 1, size: 1, lines: 1, words: 1 }
      await saveIndex(tmpDir, { "/file.md": entry })
      // If no error was thrown, the directory was created and file written
      const reloaded = await loadIndex(tmpDir)
      expect(reloaded["/file.md"]).toEqual(entry)
    }))

  test("overwrites previous index with new data", () =>
    withTmpDir(async (tmpDir) => {
      const old = { "/old.md": { mtime: 1, size: 1, lines: 1, words: 1 } }
      await saveIndex(tmpDir, old)

      const fresh = { "/new.md": { mtime: 2, size: 2, lines: 2, words: 2 } }
      await saveIndex(tmpDir, fresh)

      const result = await loadIndex(tmpDir)
      expect(result).toEqual(fresh)
      expect(result["/old.md"]).toBeUndefined()
    }))

  test("evicts deleted files — index only contains currently-discovered files", () =>
    withTmpDir(async (tmpDir) => {
      // Simulate: file was previously indexed but no longer discovered this run
      const prev = {
        "/gone.md": { mtime: 100, size: 100, lines: 5, words: 50 },
        "/still-here.md": { mtime: 200, size: 200, lines: 10, words: 100 },
      }
      await saveIndex(tmpDir, prev)

      // On next run only "/still-here.md" is discovered
      const current = { "/still-here.md": { mtime: 200, size: 200, lines: 10, words: 100 } }
      await saveIndex(tmpDir, current)

      const result = await loadIndex(tmpDir)
      expect(result["/gone.md"]).toBeUndefined()
      expect(result["/still-here.md"]).toBeDefined()
    }))
})
