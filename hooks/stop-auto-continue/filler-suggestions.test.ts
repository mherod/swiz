import { describe, expect, test } from "bun:test"
import { withGitClient } from "../../src/git/client.ts"
import { MockGitClient } from "../../src/git/mock-client.ts"
import { useTempDir } from "../../src/utils/test-utils.ts"
import { buildFillerSuggestion as buildOriginalSuggestion } from "./filler-suggestions.ts"

const { create } = useTempDir("filler-test-")
const repositories = new Set<string>()
const dirtyRepositories = new Set<string>()
const git = new MockGitClient((args, { cwd }) => {
  if (!cwd || !repositories.has(cwd)) return { exitCode: 1 }
  if (args[0] === "rev-parse" && args.includes("--git-dir")) return ".git"
  if (args[0] === "rev-parse" && args.includes("--is-inside-work-tree")) return "true"
  if (args[0] === "status") return dirtyRepositories.has(cwd) ? "?? dirty.ts" : ""
  if (args[0] === "branch") return "main"
  return { exitCode: 1 }
})
function buildFillerSuggestion(...args: Parameters<typeof buildOriginalSuggestion>) {
  return withGitClient(git, () => buildOriginalSuggestion(...args))
}

async function makeTempGitRepo(): Promise<string> {
  const dir = await create()
  repositories.add(dir)
  return dir
}

describe("buildFillerSuggestion", () => {
  test("returns commit suggestion for dirty worktree", async () => {
    const dir = await makeTempGitRepo()
    dirtyRepositories.add(dir)
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
