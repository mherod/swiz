import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"

/**
 * Behavioral tests for scripts/get-test-scope.ts.
 *
 * The script is a small bash-compatible CLI (prints space-separated test
 * paths on stdout or nothing). We exercise it as a subprocess through
 * `bun run` so the tests cover the real compiled module as invoked by
 * both lefthook and CI, including the CI_BASE env var path added for
 * issue #541.
 */

function runScopeScript(env: Record<string, string> = {}): {
  stdout: string
  exitCode: number
} {
  const proc = spawnSync("bun", ["run", "scripts/get-test-scope.ts"], {
    cwd: new URL("..", import.meta.url).pathname,
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
