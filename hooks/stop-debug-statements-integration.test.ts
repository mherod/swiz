import { describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { commitFile, makeTempGitRepo, runGit, useTempDir } from "./utils/test-utils.ts"

// Absolute path so the script is found regardless of spawn CWD.
const HOOK_PATH = resolve(process.cwd(), "hooks/stop-debug-statements.ts")

const tmp = useTempDir("swiz-stop-debug-")

/** Run the stop-debug-statements hook against a directory. */
async function runHook(dir: string): Promise<{ blocked: boolean; reason?: string; raw: string }> {
  const payload = JSON.stringify({ cwd: dir, session_id: "test-session" })
  const proc = Bun.spawn(["bun", HOOK_PATH], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    cwd: dir,
  })
  void proc.stdin.write(payload)
  void proc.stdin.end()
  const raw = await new Response(proc.stdout).text()
  await proc.exited

  const trimmed = raw.trim()
  if (!trimmed) return { blocked: false, raw: trimmed }
  const parsed = JSON.parse(trimmed)
  return {
    blocked: parsed.decision === "block",
    reason: parsed.reason,
    raw: trimmed,
  }
}

// ─── Non-git directory ────────────────────────────────────────────────────────

describe("stop-debug-statements: non-git directory", () => {
  test("hook exits silently in a non-git directory", async () => {
    const dir = await tmp.create("swiz-stop-debug-nogit-")
    const result = await runHook(dir)
    expect(result.blocked).toBe(false)
    expect(result.raw).toBe("")
  })
})

// ─── Detection: debug statements in plain source files ───────────────────────

describe("stop-debug-statements: detects debug statements in source files", () => {
  test("console.log in .ts source file is blocked", async () => {
    const dir = await makeTempGitRepo(tmp, { suffix: "-ts-log" })
    await commitFile(dir, "src/app.ts", "export function greet() {\n  console.log('hello');\n}\n")
    const result = await runHook(dir)
    expect(result.blocked).toBe(true)
    expect(result.reason).toContain("console.log")
  })

  test("debugger statement in .ts file is blocked", async () => {
    const dir = await makeTempGitRepo(tmp, { suffix: "-ts-debugger" })
    await commitFile(dir, "src/utils.ts", "export function debug() {\n  debugger;\n}\n")
    const result = await runHook(dir)
    expect(result.blocked).toBe(true)
    expect(result.reason).toContain("debugger")
  })

  test("console.debug in .js file is blocked", async () => {
    const dir = await makeTempGitRepo(tmp, { suffix: "-js-debug" })
    await commitFile(dir, "src/helper.js", "function helper() {\n  console.debug('value');\n}\n")
    const result = await runHook(dir)
    expect(result.blocked).toBe(true)
  })

  test("print() in .py file is blocked", async () => {
    const dir = await makeTempGitRepo(tmp, { suffix: "-py-print" })
    await commitFile(dir, "src/utils.py", "def run():\n    print('migrating')\n")
    const result = await runHook(dir)
    expect(result.blocked).toBe(true)
  })

  test("print() in scripts/ .py file is NOT blocked (intentional CLI output)", async () => {
    const dir = await makeTempGitRepo(tmp, { suffix: "-py-scripts" })
    await commitFile(dir, "scripts/migrate.py", "def run():\n    print('migrating')\n")
    const result = await runHook(dir)
    expect(result.blocked).toBe(false)
  })

  test("binding.pry in .rb file is blocked", async () => {
    const dir = await makeTempGitRepo(tmp, { suffix: "-rb-pry" })
    await commitFile(dir, "lib/helper.rb", "def run\n  binding.pry\nend\n")
    const result = await runHook(dir)
    expect(result.blocked).toBe(true)
  })

  test("console.log in a comment is NOT blocked", async () => {
    const dir = await makeTempGitRepo(tmp, { suffix: "-ts-comment" })
    await commitFile(dir, "src/app.ts", "// use console.log for debugging\nexport const x = 1;\n")
    const result = await runHook(dir)
    expect(result.blocked).toBe(false)
  })

  test("print() with # noqa in .py is NOT blocked", async () => {
    const dir = await makeTempGitRepo(tmp, { suffix: "-py-noqa" })
    await commitFile(dir, "scripts/debug.py", "def run():\n    print('ok')  # noqa\n")
    const result = await runHook(dir)
    expect(result.blocked).toBe(false)
  })
})

// ─── Exclusions: GENERATED_FILE_RE ───────────────────────────────────────────

describe("stop-debug-statements: GENERATED_FILE_RE exclusions allow stop", () => {
  test("console.log in main.dart.js is NOT blocked", async () => {
    const dir = await makeTempGitRepo(tmp, { suffix: "-dart-js" })
    await commitFile(dir, "build/main.dart.js", "console.log('flutter init');\n")
    const result = await runHook(dir)
    expect(result.blocked).toBe(false)
  })

  test("console.log in nested main.dart.js is NOT blocked", async () => {
    const dir = await makeTempGitRepo(tmp, { suffix: "-dart-js-nested" })
    await commitFile(dir, "apps/web/src/main.dart.js", "console.log('app');\n")
    const result = await runHook(dir)
    expect(result.blocked).toBe(false)
  })

  test("console.log in *.min.js is NOT blocked", async () => {
    const dir = await makeTempGitRepo(tmp, { suffix: "-min-js" })
    await commitFile(dir, "public/vendor.min.js", "console.log('minified');\n")
    const result = await runHook(dir)
    expect(result.blocked).toBe(false)
  })

  test("console.log in *.bundle.js is NOT blocked", async () => {
    const dir = await makeTempGitRepo(tmp, { suffix: "-bundle-js" })
    await commitFile(dir, "dist/app.bundle.js", "console.log('bundle');\n")
    const result = await runHook(dir)
    expect(result.blocked).toBe(false)
  })

  test("console.log in *.chunk.js is NOT blocked", async () => {
    const dir = await makeTempGitRepo(tmp, { suffix: "-chunk-js" })
    await commitFile(dir, "dist/123.chunk.js", "console.log('chunk');\n")
    const result = await runHook(dir)
    expect(result.blocked).toBe(false)
  })

  test("console.log in *.dart.js (non-main) is NOT blocked", async () => {
    const dir = await makeTempGitRepo(tmp, { suffix: "-dart-js-other" })
    await commitFile(dir, "build/output.dart.js", "console.log('other');\n")
    const result = await runHook(dir)
    expect(result.blocked).toBe(false)
  })
})

// ─── Exclusions: INFRA_FILE_RE ────────────────────────────────────────────────

describe("stop-debug-statements: INFRA_FILE_RE exclusions allow stop", () => {
  test("console.log in hooks/ directory is NOT blocked", async () => {
    const dir = await makeTempGitRepo(tmp, { suffix: "-hooks-infra" })
    await commitFile(
      dir,
      "hooks/my-hook.ts",
      "console.log(JSON.stringify({ decision: 'allow' }));\n"
    )
    const result = await runHook(dir)
    expect(result.blocked).toBe(false)
  })

  test("console.log in src/commands/ is NOT blocked", async () => {
    const dir = await makeTempGitRepo(tmp, { suffix: "-commands-infra" })
    await commitFile(
      dir,
      "src/commands/status.ts",
      "export function run() { console.log('status'); }\n"
    )
    const result = await runHook(dir)
    expect(result.blocked).toBe(false)
  })

  test("console.log in index.ts is NOT blocked", async () => {
    const dir = await makeTempGitRepo(tmp, { suffix: "-index-infra" })
    await commitFile(dir, "index.ts", "console.log('entry point');\n")
    const result = await runHook(dir)
    expect(result.blocked).toBe(false)
  })

  test("console.log in dispatch.ts is NOT blocked", async () => {
    const dir = await makeTempGitRepo(tmp, { suffix: "-dispatch-infra" })
    await commitFile(dir, "dispatch.ts", "console.log('dispatching');\n")
    const result = await runHook(dir)
    expect(result.blocked).toBe(false)
  })
})

// ─── Exclusions: TEST_FILE_RE ─────────────────────────────────────────────────

describe("stop-debug-statements: TEST_FILE_RE exclusions allow stop", () => {
  test("console.log in *.test.ts is NOT blocked", async () => {
    const dir = await makeTempGitRepo(tmp, { suffix: "-test-ts" })
    await commitFile(
      dir,
      "src/app.test.ts",
      "test('debug', () => { console.log('test output'); });\n"
    )
    const result = await runHook(dir)
    expect(result.blocked).toBe(false)
  })

  test("console.log in *.spec.js is NOT blocked", async () => {
    const dir = await makeTempGitRepo(tmp, { suffix: "-spec-js" })
    await commitFile(dir, "src/app.spec.js", "it('works', () => { console.log('spec'); });\n")
    const result = await runHook(dir)
    expect(result.blocked).toBe(false)
  })
})

// ─── Mixed: excluded + non-excluded in same commit ───────────────────────────

describe("stop-debug-statements: mixed commits", () => {
  test("debug in both generated and source file — blocked for source, not generated", async () => {
    const dir = await makeTempGitRepo(tmp, { suffix: "-mixed" })
    // Commit both file types together in one commit (the 11th, within HEAD~10..HEAD)
    await mkdir(join(dir, "build"), { recursive: true })
    await mkdir(join(dir, "src"), { recursive: true })
    await writeFile(join(dir, "build/main.dart.js"), "console.log('flutter');\n")
    await writeFile(join(dir, "src/lib.ts"), "export function run() { console.log('debug'); }\n")
    await runGit(dir, ["add", "."])
    await runGit(dir, ["commit", "-m", "add mixed files"])

    const result = await runHook(dir)
    expect(result.blocked).toBe(true)
    expect(result.reason).toContain("console.log")
  })

  test("only generated files changed — hook exits silently", async () => {
    const dir = await makeTempGitRepo("-only-generated")
    await commitFile(dir, "dist/app.bundle.js", "console.log('bundle init');\n")
    const result = await runHook(dir)
    expect(result.blocked).toBe(false)
  })
})

// ─── Shallow repo (< 11 commits) — empty-tree fallback path ──────────────────
//
// These tests use repos with 0 seed commits so HEAD~10 doesn't exist.
// The hook falls back to `git diff <empty-tree>..HEAD`, which covers all
// committed content regardless of history depth.

describe("stop-debug-statements: shallow repo (< 11 commits)", () => {
  test("console.log in first-ever commit is blocked", async () => {
    const dir = await makeTempGitRepo(tmp, { suffix: "-shallow-detect", seedCommits: 0 })
    await commitFile(dir, "src/app.ts", "export function run() { console.log('debug'); }\n")
    const result = await runHook(dir)
    expect(result.blocked).toBe(true)
    expect(result.reason).toContain("console.log")
  })

  test("debugger in first-ever commit is blocked", async () => {
    const dir = await makeTempGitRepo(tmp, { suffix: "-shallow-debugger", seedCommits: 0 })
    await commitFile(dir, "src/utils.ts", "function check() { debugger; }\n")
    const result = await runHook(dir)
    expect(result.blocked).toBe(true)
  })

  test("console.log in generated file in first commit is NOT blocked", async () => {
    const dir = await makeTempGitRepo(tmp, { suffix: "-shallow-generated", seedCommits: 0 })
    await commitFile(dir, "build/main.dart.js", "console.log('flutter bootstrap');\n")
    const result = await runHook(dir)
    expect(result.blocked).toBe(false)
  })

  test("console.log in hooks/ in first commit is NOT blocked", async () => {
    const dir = await makeTempGitRepo(tmp, { suffix: "-shallow-infra", seedCommits: 0 })
    await commitFile(dir, "hooks/my-hook.ts", "console.log(JSON.stringify({ ok: true }));\n")
    const result = await runHook(dir)
    expect(result.blocked).toBe(false)
  })

  test("console.log in test file in first commit is NOT blocked", async () => {
    const dir = await makeTempGitRepo(tmp, { suffix: "-shallow-test", seedCommits: 0 })
    await commitFile(dir, "src/app.test.ts", "test('x', () => { console.log('test'); });\n")
    const result = await runHook(dir)
    expect(result.blocked).toBe(false)
  })

  test("repo with 5 commits containing console.log is blocked", async () => {
    const dir = await makeTempGitRepo(tmp, { suffix: "-five-commits", seedCommits: 4 })
    await commitFile(dir, "src/lib.ts", "export const x = () => { console.log('five'); };\n")
    const result = await runHook(dir)
    expect(result.blocked).toBe(true)
  })
})
