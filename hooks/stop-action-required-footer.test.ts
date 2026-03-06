/**
 * Regression tests: every stop hook block path using blockStop() must include the
 * ACTION REQUIRED footer. Each test triggers a real denial path with a minimal
 * fixture and asserts the footer is present in the block reason.
 *
 * Intentionally excluded:
 * - stop-auto-continue.ts: uses blockStopRaw() by design — no footer appended
 * - stop-personal-repo-issues.ts: covered by its own E2E suite with a mock gh binary
 * - GitHub API hooks (stop-pr-*, stop-branch-conflicts, stop-github-ci): require live API
 */

import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const HOOKS_DIR = resolve(process.cwd(), "hooks")
const FOOTER_MARKER = "ACTION REQUIRED"

const tempDirs: string[] = []

afterAll(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    await rm(dir, { recursive: true, force: true })
  }
})

async function makeTempDir(suffix = ""): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `swiz-stop-footer${suffix}-`))
  tempDirs.push(dir)
  return dir
}

async function runGit(dir: string, args: string[]): Promise<string> {
  const p = Bun.spawn(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" })
  const out = await new Response(p.stdout).text()
  await p.exited
  return out.trim()
}

/** Create a git repo with one empty seed commit (so HEAD is valid). */
async function makeTempGitRepo(suffix = ""): Promise<string> {
  const dir = await makeTempDir(suffix)
  await runGit(dir, ["init"])
  await runGit(dir, ["config", "user.email", "test@example.com"])
  await runGit(dir, ["config", "user.name", "Test"])
  await runGit(dir, ["commit", "--allow-empty", "-m", "init"])
  return dir
}

/** Write a file, stage it, and create a commit. Creates parent directories as needed. */
async function commitFile(dir: string, relPath: string, content: string): Promise<void> {
  const parts = relPath.split("/")
  if (parts.length > 1) {
    await mkdir(join(dir, ...parts.slice(0, -1)), { recursive: true })
  }
  await writeFile(join(dir, relPath), content)
  await runGit(dir, ["add", relPath])
  await runGit(dir, ["commit", "-m", `add ${relPath}`])
}

interface HookResult {
  blocked: boolean
  reason?: string
}

async function runStopHook(
  hookFile: string,
  payload: unknown,
  opts: { env?: Record<string, string>; cwd?: string } = {}
): Promise<HookResult> {
  const proc = Bun.spawn(["bun", join(HOOKS_DIR, hookFile)], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    cwd: opts.cwd ?? process.cwd(),
    env: { ...process.env, ...opts.env },
  })
  proc.stdin.write(JSON.stringify(payload))
  proc.stdin.end()
  const raw = await new Response(proc.stdout).text()
  await proc.exited

  const trimmed = raw.trim()
  if (!trimmed) return { blocked: false }
  try {
    const parsed = JSON.parse(trimmed)
    return {
      blocked: parsed.decision === "block",
      reason: parsed.reason as string | undefined,
    }
  } catch {
    return { blocked: false }
  }
}

describe("stop hook ACTION REQUIRED footer regression", () => {
  test("stop-git-status: uncommitted changes block includes footer", async () => {
    const dir = await makeTempGitRepo("-git-status")
    // Untracked file — not committed — triggers the hasUncommitted path
    await writeFile(join(dir, "app.ts"), "export const x = 1\n")
    const result = await runStopHook("stop-git-status.ts", { cwd: dir }, { cwd: dir })
    expect(result.blocked).toBe(true)
    expect(result.reason).toContain(FOOTER_MARKER)
  })

  test("stop-debug-statements: console.log in source block includes footer", async () => {
    const dir = await makeTempGitRepo("-debug")
    await commitFile(dir, "src/app.ts", "export function run() {\n  console.log('debug');\n}\n")
    const result = await runStopHook("stop-debug-statements.ts", { cwd: dir }, { cwd: dir })
    expect(result.blocked).toBe(true)
    expect(result.reason).toContain(FOOTER_MARKER)
  })

  test("stop-todo-tracker: TODO comment in source block includes footer", async () => {
    const dir = await makeTempGitRepo("-todo")
    await commitFile(
      dir,
      "src/service.ts",
      "export function serve() {\n  // TODO: implement this\n}\n"
    )
    const result = await runStopHook("stop-todo-tracker.ts", { cwd: dir }, { cwd: dir })
    expect(result.blocked).toBe(true)
    expect(result.reason).toContain(FOOTER_MARKER)
  })

  test("stop-secret-scanner: credential in committed source block includes footer", async () => {
    const dir = await makeTempGitRepo("-secret")
    // Value has no excluded words (example/placeholder/test/fake/dummy/replace/env.)
    // and is 20 chars (> the 8-char minimum required by GENERIC_SECRET_RE)
    const credLine = `const password = "aBcDeFgHiJ0123456789"\n`
    await commitFile(dir, "src/db.ts", credLine)
    const result = await runStopHook("stop-secret-scanner.ts", { cwd: dir }, { cwd: dir })
    expect(result.blocked).toBe(true)
    expect(result.reason).toContain(FOOTER_MARKER)
  })

  test("stop-large-files: >500KB committed file block includes footer", async () => {
    const dir = await makeTempGitRepo("-large")
    await mkdir(join(dir, "assets"), { recursive: true })
    // 600KB binary — well above the 500KB threshold
    await Bun.write(join(dir, "assets/large.bin"), Buffer.alloc(600 * 1024, 65))
    await runGit(dir, ["add", "assets/large.bin"])
    await runGit(dir, ["commit", "-m", "add large binary"])
    const result = await runStopHook("stop-large-files.ts", { cwd: dir }, { cwd: dir })
    expect(result.blocked).toBe(true)
    expect(result.reason).toContain(FOOTER_MARKER)
  })

  test("stop-completion-auditor: in_progress task block includes footer", async () => {
    const fakeHome = await makeTempDir("-home")
    const sessionId = "test-footer-auditor-session"
    const tasksDir = join(fakeHome, ".claude", "tasks", sessionId)
    await mkdir(tasksDir, { recursive: true })
    await writeFile(
      join(tasksDir, "task-1.json"),
      JSON.stringify({ id: "task-1", status: "in_progress", subject: "Unfinished work" })
    )
    const result = await runStopHook(
      "stop-completion-auditor.ts",
      { cwd: process.cwd(), session_id: sessionId, transcript_path: "" },
      { env: { HOME: fakeHome } }
    )
    expect(result.blocked).toBe(true)
    expect(result.reason).toContain(FOOTER_MARKER)
  })

  test("stop-lockfile-drift: package.json changed without lockfile update block includes footer", async () => {
    // Unique session ID avoids the per-session sentinel blocking a re-run
    const sessionId = `test-footer-lockfile-${Date.now()}`
    const dir = await makeTempGitRepo("-lockfile")
    // Untracked lockfile on disk — hook detects npm as the package manager
    await writeFile(join(dir, "package-lock.json"), "{}")
    // Commit package.json with a dependencies section but do NOT commit the lockfile
    await commitFile(
      dir,
      "package.json",
      JSON.stringify(
        { name: "test", version: "1.0.0", dependencies: { lodash: "^4.0.0" } },
        null,
        2
      )
    )
    const result = await runStopHook(
      "stop-lockfile-drift.ts",
      { cwd: dir, session_id: sessionId },
      { cwd: dir }
    )
    expect(result.blocked).toBe(true)
    expect(result.reason).toContain(FOOTER_MARKER)
  })
})
