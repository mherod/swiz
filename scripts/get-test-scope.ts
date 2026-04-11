import { spawnSync } from "node:child_process"
import { existsSync, readdirSync } from "node:fs"
import { basename, dirname } from "node:path"

/**
 * Script to determine which tests to run pre-push, mirroring CI logic.
 * It compares origin/main (if available) with HEAD to find changed files.
 */

function getGitOutput(args: string[]): string {
  const proc = spawnSync("git", args, { encoding: "utf8" })
  if (proc.status !== 0) return ""
  return proc.stdout.trim()
}

function resolveBase(): string {
  // If we have origin/main, use it as the base
  const hasOriginMain = getGitOutput(["rev-parse", "--verify", "origin/main"])
  if (hasOriginMain) {
    return "origin/main"
  }
  // Fallback to a few commits back
  return "HEAD~4"
}

const base = resolveBase()
const changedFiles = getGitOutput(["diff", "--name-only", base, "HEAD"]).split("\n").filter(Boolean)

const testFiles = new Set<string>()

/**
 * Locate test files associated with a sub-module entry by walking up to its
 * parent directory and looking for a `<parent-dir>.test.ts` (and any siblings
 * matching `<parent-dir>*.test.ts`). This is the convention for hook bundles
 * like `hooks/stop-personal-repo-issues/issues.ts` whose tests live at
 * `hooks/stop-personal-repo-issues.test.ts` and
 * `hooks/stop-personal-repo-issues-e2e.test.ts`. Without this lookup the
 * sibling-only check returns nothing and the lefthook test step falls back
 * to its multi-thousand-file safe-subset path, which is the source of every
 * concurrent-mode flake we have hit on push.
 */
function findParentBundleTests(file: string): string[] {
  const parentDir = dirname(file) // hooks/stop-personal-repo-issues
  const grandparent = dirname(parentDir) // hooks
  const bundleName = basename(parentDir) // stop-personal-repo-issues
  if (!bundleName || bundleName === "." || bundleName === "/") return []

  const found: string[] = []
  try {
    for (const entry of readdirSync(grandparent)) {
      if (
        entry.startsWith(bundleName) &&
        (entry.endsWith(".test.ts") || entry.endsWith(".test.tsx") || entry.endsWith(".spec.ts"))
      ) {
        found.push(`${grandparent}/${entry}`)
      }
    }
  } catch {
    // Non-fatal: missing grandparent directory just means no parent bundle tests.
  }
  return found
}

for (const file of changedFiles) {
  if (file.includes("node_modules/")) continue

  if (file.endsWith(".test.ts") || file.endsWith(".test.tsx") || file.endsWith(".spec.ts")) {
    testFiles.add(file)
    continue
  }
  if (!file.endsWith(".ts") && !file.endsWith(".tsx")) continue

  // 1) Sibling test file: src/foo.ts → src/foo.test.ts
  const baseName = file.replace(/\.tsx?$/, "")
  let matched = false
  for (const ext of [".test.ts", ".test.tsx", ".spec.ts"]) {
    const testCandidate = baseName + ext
    if (existsSync(testCandidate)) {
      testFiles.add(testCandidate)
      matched = true
      break
    }
  }
  if (matched) continue

  // 2) Parent-bundle test files: hooks/foo/bar.ts → hooks/foo.test.ts,
  //    hooks/foo-e2e.test.ts, etc. The grandparent directory listing finds
  //    every test file whose basename starts with the parent dir name.
  for (const t of findParentBundleTests(file)) {
    testFiles.add(t)
  }
}

// Filter out known slow/flaky tests from pre-push (keep consistent with current lefthook)
const SKIP_PATTERNS = [
  "stop-auto-continue",
  "commands/dispatch.test",
  "commands/dispatch-formats.test",
  "commands/cleanup.test",
  "commands/skill.test",
  "commands/status.test",
  "stop-personal-repo-issues-e2e",
  "stop-secret-scanner",
  "commands/state.test",
  "commands/compact.test",
  "commands/doctor.test",
  "positive-path-integration",
  "commands/manage.test",
  "commands/tasks.test",
  "commands/issue.test",
  "transcript-session-gemini",
  "commands/settings.test",
  "commands/ci-wait.test",
  "commands/daemon.test",
  "commands/memory.test",
  "commands/reflect.test",
  "commands/usage.test",
  "commands/idea.test",
]

const filteredTests = Array.from(testFiles).filter((f) => !SKIP_PATTERNS.some((p) => f.includes(p)))

if (filteredTests.length > 0 && filteredTests.length <= 15) {
  process.stdout.write(filteredTests.join(" "))
} else {
  // Too many or no direct tests -> fallback to the "safe subset" strategy
  // We'll let lefthook handle the full list if this script outputs nothing.
}
