import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { spawnWithTimeout } from "../../src/utils/process-utils.ts"
import { useTempDir } from "../../src/utils/test-utils.ts"
import { buildFillerSuggestion } from "./filler-suggestions.ts"

const { create } = useTempDir("filler-test-")

async function makeTempGitRepo(): Promise<string> {
  const dir = await create()
  const result = await spawnWithTimeout(["git", "init"], { cwd: dir })
  expect(result.exitCode).toBe(0)
  return dir
}

describe("buildFillerSuggestion", () => {
  test("returns commit suggestion for dirty worktree", async () => {
    const dir = await makeTempGitRepo()
    await Bun.write(join(dir, "dirty.ts"), "change")
    const result = await buildFillerSuggestion({ cwd: dir })
    expect(result).toContain("uncommitted file(s)")
    expect(result).toContain("/commit")
  })

  test("returns empty string for clean repo with no context", async () => {
    const dir = await makeTempGitRepo()
    const result = await buildFillerSuggestion({ cwd: dir })
    expect(result).toBe("")
  })

  test("suggests hook tests when hooks edited without tests", async () => {
    const dir = await makeTempGitRepo()
    const result = await buildFillerSuggestion({
      cwd: dir,
      editedFiles: ["hooks/my-hook.ts", "hooks/another-hook.ts"],
    })
    expect(result).toContain("tests for the edited hook files")
  })

  test("suggests review when many files edited", async () => {
    const dir = await makeTempGitRepo()
    const result = await buildFillerSuggestion({
      cwd: dir,
      editedFiles: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts", "src/f.ts"],
    })
    expect(result).toContain("breadth of changes")
  })

  test("does not suggest hook tests when test files are included", async () => {
    const dir = await makeTempGitRepo()
    const result = await buildFillerSuggestion({
      cwd: dir,
      editedFiles: ["hooks/my-hook.ts", "hooks/my-hook.test.ts"],
    })
    // Should not trigger the hook-without-tests path
    expect(result).not.toContain("tests for the edited hook files")
  })

  test("returns empty for non-git directory", async () => {
    const dir = await create()
    const result = await buildFillerSuggestion({ cwd: dir })
    expect(result).toBe("")
  })
})
