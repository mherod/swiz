import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"

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
  // Prefer comparing against the remote tracking branch (feature branches / dependabot)
  // so pre-push doesn't fall back to the huge "safe subset" when origin/main differs
  // by many unrelated commits.
  const current = getGitOutput(["rev-parse", "--abbrev-ref", "HEAD"])
  if (current && current !== "HEAD") {
    const hasOriginCurrent = getGitOutput(["rev-parse", "--verify", `origin/${current}`])
    if (hasOriginCurrent) return `origin/${current}`
  }
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

for (const file of changedFiles) {
  if (file.includes("node_modules/")) continue

  if (file.endsWith(".test.ts") || file.endsWith(".test.tsx") || file.endsWith(".spec.ts")) {
    testFiles.add(file)
  } else if (file === "hooks/schemas.ts") {
    testFiles.add("src/gemini-event-map.contract.test.ts")
  } else if (file.endsWith(".ts") || file.endsWith(".tsx")) {
    // Check for sibling test file
    const baseName = file.replace(/\.tsx?$/, "")
    for (const ext of [".test.ts", ".test.tsx", ".spec.ts"]) {
      const testCandidate = baseName + ext
      if (existsSync(testCandidate)) {
        testFiles.add(testCandidate)
        break
      }
    }
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
