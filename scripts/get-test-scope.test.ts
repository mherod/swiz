import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * Behavioral tests for scripts/get-test-scope.ts.
 *
 * The script is a small bash-compatible CLI (prints space-separated test
 * paths on stdout or nothing). We exercise it as a subprocess through
 * `bun run` so the tests cover the real compiled module as invoked by
 * both lefthook and CI, including the CI_BASE env var path added for
 * issue #541.
 */

const PROJECT_ROOT = new URL("..", import.meta.url).pathname
const SCOPE_SCRIPT = join(PROJECT_ROOT, "scripts/get-test-scope.ts")

function runScopeScript(env: Record<string, string> = {}): {
  stdout: string
  exitCode: number
} {
  const proc = spawnSync("bun", ["run", "scripts/get-test-scope.ts"], {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    env: { ...process.env, ...env },
  })
  return {
    stdout: (proc.stdout ?? "").trim(),
    exitCode: proc.status ?? -1,
  }
}

describe("get-test-scope CI_BASE handling", () => {
  test("exits cleanly with empty or populated output", () => {
    // Any invocation should exit 0; the output set depends on current
    // git diff and may legitimately be empty when the local checkout
    // is clean. We only assert the contract.
    const result = runScopeScript()
    expect(result.exitCode).toBe(0)
    expect(typeof result.stdout).toBe("string")
  })

  test("treats the all-zero sha as 'no base' and falls back", () => {
    // GitHub's `github.event.before` is 0000... for brand-new branches.
    // The script must not try to rev-parse that value and must fall
    // through to origin/main / HEAD~4 instead.
    const result = runScopeScript({
      CI_BASE: "0000000000000000000000000000000000000000",
    })
    expect(result.exitCode).toBe(0)
  })

  test("treats an empty CI_BASE the same as unset", () => {
    const result = runScopeScript({ CI_BASE: "" })
    expect(result.exitCode).toBe(0)
  })

  test("accepts a real commit sha as base and diffs from there", () => {
    // Use HEAD~1 as a pragmatic 'real commit' — the script should
    // accept it and compute a diff without throwing. Output may be
    // any value depending on the actual diff.
    const head1 = spawnSync("git", ["rev-parse", "HEAD~1"], {
      cwd: new URL("..", import.meta.url).pathname,
      encoding: "utf8",
    })
    if (head1.status !== 0 || !head1.stdout) {
      // Skip when there is no HEAD~1 (shallow clone).
      return
    }
    const result = runScopeScript({ CI_BASE: head1.stdout.trim() })
    expect(result.exitCode).toBe(0)
  })

  test("ignores a non-existent sha and falls through", () => {
    // rev-parse ^{commit} against a bogus sha fails; the script must
    // fall through to the local-fallback path instead of erroring.
    const result = runScopeScript({
      CI_BASE: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    })
    expect(result.exitCode).toBe(0)
  })
})

describe("get-test-scope parent-bundle lookup", () => {
  /**
   * Run the scope script from a controlled temp git repo so we can assert
   * exactly which test paths are emitted for a given set of changed files.
   * The temp repo mirrors the hooks/<bundle>/<file>.ts → hooks/<bundle>.test.ts
   * convention required by issue #547.
   *
   * The walk-up logic was added in commit 27a9d4e5 via findParentBundleTests().
   * These tests lock in that behavior so future refactors cannot regress it.
   */
  function runScopeScriptFromDir(dir: string, env: Record<string, string> = {}) {
    const proc = spawnSync("bun", ["run", SCOPE_SCRIPT], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, ...env },
    })
    return { stdout: (proc.stdout ?? "").trim(), exitCode: proc.status ?? -1 }
  }

  function git(args: string[], cwd: string) {
    return spawnSync("git", args, {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "test",
        GIT_AUTHOR_EMAIL: "test@test.com",
        GIT_COMMITTER_NAME: "test",
        GIT_COMMITTER_EMAIL: "test@test.com",
      },
    })
  }

  function makeTempFixtureRepo(): { dir: string; baseCommit: string } {
    const dir = join(
      tmpdir(),
      `swiz-scope-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    )
    mkdirSync(join(dir, "hooks", "my-bundle"), { recursive: true })

    // Seed files that must be present for readdirSync to find them
    writeFileSync(join(dir, "hooks", "my-bundle.test.ts"), "// bundle test\n")
    writeFileSync(join(dir, "hooks", "my-bundle.ts"), "// bundle entry\n")
    writeFileSync(join(dir, "hooks", "my-bundle", "helper.ts"), "// helper\n")

    git(["init"], dir)
    git(["add", "."], dir)
    git(["commit", "--allow-empty-message", "-m", "init"], dir)

    const baseCommit = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: dir,
      encoding: "utf8",
    }).stdout.trim()

    // Modify the nested file to create a diff against the base commit
    writeFileSync(join(dir, "hooks", "my-bundle", "helper.ts"), "// helper (modified)\n")
    git(["add", "."], dir)
    git(["commit", "-m", "edit nested"], dir)

    return { dir, baseCommit }
  }

  test("hooks/<bundle>/<file>.ts returns hooks/<bundle>.test.ts (issue #547)", () => {
    const { dir, baseCommit } = makeTempFixtureRepo()
    const result = runScopeScriptFromDir(dir, { CI_BASE: baseCommit })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("hooks/my-bundle.test.ts")
  })

  test("direct entry hooks/<bundle>.ts still returns hooks/<bundle>.test.ts", () => {
    const dir = join(
      tmpdir(),
      `swiz-scope-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    )
    mkdirSync(join(dir, "hooks"), { recursive: true })
    writeFileSync(join(dir, "hooks", "my-bundle.test.ts"), "// bundle test\n")
    writeFileSync(join(dir, "hooks", "my-bundle.ts"), "// bundle entry\n")
    git(["init"], dir)
    git(["add", "."], dir)
    git(["commit", "--allow-empty-message", "-m", "init"], dir)
    const baseCommit = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: dir,
      encoding: "utf8",
    }).stdout.trim()
    writeFileSync(join(dir, "hooks", "my-bundle.ts"), "// bundle entry (modified)\n")
    git(["add", "."], dir)
    git(["commit", "-m", "edit entry"], dir)

    const result = runScopeScriptFromDir(dir, { CI_BASE: baseCommit })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("hooks/my-bundle.test.ts")
  })
})
