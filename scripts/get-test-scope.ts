import { spawnSync } from "node:child_process"
import { existsSync, readdirSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { preProcessFile } from "typescript"

/**
 * Script to determine which tests to run pre-push, mirroring CI logic.
 * It compares origin/main (if available) with HEAD to find changed files.
 */

function getGitOutput(args: string[]): string {
  const proc = spawnSync("git", args, { encoding: "utf8", timeout: 20_000 })
  if (proc.status !== 0) return ""
  return proc.stdout.trim()
}

function resolveBase(): string {
  // CI passes its base sha explicitly via CI_BASE so we honor the event
  // context (previous push head for `push`, PR base for `pull_request`).
  // The raw zero-sha that GitHub sends for brand-new branches is treated
  // the same as "no base" so we drop through to the local fallbacks.
  const envBase = process.env.CI_BASE
  if (
    envBase &&
    envBase.trim() !== "" &&
    envBase !== "0000000000000000000000000000000000000000" &&
    getGitOutput(["rev-parse", "--verify", `${envBase}^{commit}`]) !== ""
  ) {
    return envBase
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
const args = process.argv.slice(2).filter(Boolean)
const isTargetedByArgs = args.length > 0

const changedFiles = isTargetedByArgs
  ? args
  : getGitOutput(["diff", "--name-only", base, "HEAD"]).split("\n").filter(Boolean)

const testFiles = new Set<string>()
// Test files the developer changed directly. These must always run, even when
// they match SKIP_PATTERNS — skipping a file you just edited would drop the only
// test that exercises the change and fall through to the flaky safe-subset run.
const directlyChangedTests = new Set<string>()
const directImporters = new Set<string>()
const changedSources = new Set<string>()

/** Inventory shared by importer discovery and the recurring excluded-suite run. */
function listTests(): string[] {
  return [
    ...new Bun.Glob("{src,hooks,scripts}/**/*.{test,spec}.{ts,tsx}").scanSync({
      cwd: process.cwd(),
      onlyFiles: true,
    }),
  ].sort()
}

/** Match relative imports without confusing comments or string literals for edges. */
async function findDirectImporters(sources: Set<string>): Promise<void> {
  if (sources.size === 0) return
  for (const testFile of listTests()) {
    const source = await Bun.file(testFile).text()
    const imports = preProcessFile(source, true, true).importedFiles
    for (const { fileName } of imports) {
      if (!fileName.startsWith(".")) continue
      const path = resolve(dirname(testFile), fileName)
      const candidates = [
        path,
        `${path}.ts`,
        `${path}.tsx`,
        `${path}/index.ts`,
        `${path}/index.tsx`,
      ]
      if (candidates.some((candidate) => sources.has(candidate))) {
        testFiles.add(testFile)
        directImporters.add(testFile)
        break
      }
    }
  }
}

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
        found.push(join(grandparent, entry))
      }
    }
  } catch {
    // Non-fatal: missing grandparent directory just means no parent bundle tests.
  }
  return found
}

// Explicit source→test mappings for files whose test names don't match the
// standard sibling convention (e.g. governance bundle → thin-wrapper tests).
const TEST_ALIASES: Record<string, string[]> = {
  "hooks/pretooluse-task-governance.ts": [
    "hooks/pretooluse-enforce-taskupdate.test.ts",
    "src/pretooluse-require-tasks.test.ts",
  ],
}

for (const file of changedFiles) {
  if (file.includes("node_modules/")) continue

  if (file.endsWith(".test.ts") || file.endsWith(".test.tsx") || file.endsWith(".spec.ts")) {
    if (!existsSync(file)) continue
    testFiles.add(file)
    directlyChangedTests.add(file)
    continue
  }
  if (!file.endsWith(".ts") && !file.endsWith(".tsx")) continue
  changedSources.add(resolve(file))

  // 0) Explicit alias mapping for non-standard source→test associations
  const aliases = TEST_ALIASES[file]
  if (aliases) {
    for (const alias of aliases) {
      if (existsSync(alias)) testFiles.add(alias)
    }
  }

  // 1) Sibling test file: src/foo.ts → src/foo.test.ts
  const baseName = file.replace(/\.tsx?$/, "")
  for (const ext of [".test.ts", ".test.tsx", ".spec.ts"]) {
    const testCandidate = baseName + ext
    if (existsSync(testCandidate)) {
      testFiles.add(testCandidate)
    }
  }

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
  "scripts/get-test-scope",
]

if (args.includes("--excluded")) {
  process.stdout.write(
    listTests()
      .filter((f) => SKIP_PATTERNS.some((p) => f.includes(p)))
      .join(" ")
  )
  process.exit(0)
}

await findDirectImporters(changedSources)

const filteredTests = Array.from(testFiles).filter(
  (f) =>
    directlyChangedTests.has(f) ||
    directImporters.has(f) ||
    !SKIP_PATTERNS.some((p) => f.includes(p))
)

if (filteredTests.length > 0 && filteredTests.length <= 30) {
  process.stdout.write(filteredTests.join(" "))
} else if (changedFiles.length > 0 && filteredTests.length === 0) {
  // A changed-file list we actually computed — whether it arrived as args
  // (lefthook) or from the diff (CI) — that maps to zero tests is a real
  // "nothing to run" answer, not an unknown scope. Gating this on args
  // alone left CI unable to ever reach it, so every docs-only and
  // deps-only change fell through to the flaky full run (#680).
  process.stdout.write("no-tests-affected")
} else {
  // Too many tests, or the changed-file list came back empty because we
  // could not resolve a base at all -> fall back to the "safe subset"
  // strategy. We'll let lefthook handle the full list if this script
  // outputs nothing.
}
