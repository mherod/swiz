import { describe, expect, test } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildFillerSuggestion } from "./filler-suggestions.ts"

async function makeTempGitRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "filler-test-"))
  const run = (args: string[]) =>
    Bun.spawn(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" })
  await run(["init"]).exited
  await run(["config", "user.email", "test@test.com"]).exited
  await run(["config", "user.name", "Test"]).exited
  // Create initial commit so branch exists
  await writeFile(join(dir, "README.md"), "init")
  await run(["add", "."]).exited
  await run(["commit", "-m", "init"]).exited
  return dir
}

describe("buildFillerSuggestion", () => {
  test("returns commit suggestion for dirty worktree", async () => {
    const dir = await makeTempGitRepo()
    await writeFile(join(dir, "dirty.ts"), "change")
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
    const dir = await mkdtemp(join(tmpdir(), "filler-nogit-"))
    const result = await buildFillerSuggestion({ cwd: dir })
    expect(result).toBe("")
  })
})
