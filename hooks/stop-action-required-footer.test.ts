/**
 * Regression tests: every stop hook block path using blockStop() must include the
 * ACTION REQUIRED footer. Each test triggers a real denial path with a minimal
 * fixture and asserts the footer is present in the block reason.
 *
 * Intentionally excluded:
 * - stop-auto-continue.ts: uses blockStopRaw() by design — no footer appended
 * - stop-personal-repo-issues.ts: covered by its own E2E suite with a mock gh binary
 * - GitHub API hooks (stop-pr-*, stop-branch-conflicts, stop-ship-checklist CI slice): require live API
 */

import { describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { AGENTS } from "../src/agents.ts"
import { getSessionTasksDir } from "../src/tasks/task-recovery.ts"
import { commitFile, makeTempGitRepo, runGit, useTempDir } from "../src/utils/test-utils.ts"

const HOOKS_DIR = resolve(process.cwd(), "hooks")
const FOOTER_MARKER = "You must act on this now."

const tmp = useTempDir("swiz-stop-footer-")

interface HookResult {
  blocked: boolean
  reason?: string
}

async function runStopHook(
  hookFile: string,
  payload: unknown,
  opts: { env?: Record<string, string>; cwd?: string } = {}
): Promise<HookResult> {
  const env: Record<string, string | undefined> = { ...process.env, ...opts.env }
  for (const agent of AGENTS) {
    for (const v of agent.envVars ?? []) env[v] = ""
  }
  const proc = Bun.spawn(["bun", join(HOOKS_DIR, hookFile)], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    cwd: opts.cwd ?? process.cwd(),
    env: env as Record<string, string>,
  })
  await proc.stdin.write(JSON.stringify(payload))
  await proc.stdin.end()
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
    const dir = await makeTempGitRepo(tmp, { suffix: "-git-status" })
    // Untracked file — not committed — triggers the hasUncommitted path
    await writeFile(join(dir, "app.ts"), "export const x = 1\n")
    const result = await runStopHook("stop-git-status.ts", { cwd: dir }, { cwd: dir })
    expect(result.blocked).toBe(true)
    expect(result.reason).toContain(FOOTER_MARKER)
    expect(result.reason).not.toContain("/re-assess")
    expect(result.reason).not.toContain("re-assess skill")
  })

  //  test("stop-debug-statements: console.log in source block includes footer", async () => {
  //    const dir = await makeTempGitRepo(tmp, { suffix: "-debug" })
  //    await commitFile(dir, "src/app.ts", "export function run() {\n  console.log('debug');\n}\n")
  //    const result = await runStopHook("stop-debug-statements.ts", { cwd: dir }, { cwd: dir })
  //    expect(result.blocked).toBe(true)
  //    expect(result.reason).toContain(FOOTER_MARKER)
  //  })

  test("stop-todo-tracker: TODO comment in source block includes footer", async () => {
    const dir = await makeTempGitRepo(tmp, { suffix: "-todo" })
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
    const dir = await makeTempGitRepo(tmp, { suffix: "-secret" })
    // Value has no excluded words (example/placeholder/test/fake/dummy/replace/env.)
    // and is 20 chars (> the 8-char minimum required by GENERIC_SECRET_RE)
    const credLine = `const password = "aBcDeFgHiJ0123456789"\n`
    await commitFile(dir, "src/db.ts", credLine)
    const result = await runStopHook("stop-secret-scanner.ts", { cwd: dir }, { cwd: dir })
    expect(result.blocked).toBe(true)
    expect(result.reason).toContain(FOOTER_MARKER)
  })

  test("stop-large-files: >500KB committed file block includes footer", async () => {
    const dir = await makeTempGitRepo(tmp, { suffix: "-large" })
    await mkdir(join(dir, "assets"), { recursive: true })
    // 600KB binary — well above the 500KB threshold
    await Bun.write(join(dir, "assets/large.bin"), Buffer.alloc(600 * 1024, 65))
    await runGit(dir, ["add", "assets/large.bin"])
    await runGit(dir, ["commit", "-m", "add large binary"])
    const result = await runStopHook("stop-large-files.ts", { cwd: dir }, { cwd: dir })
    expect(result.blocked).toBe(true)
    expect(result.reason).toContain(FOOTER_MARKER)
  })

  test("stop-incomplete-tasks: in_progress task block includes footer", async () => {
    const fakeHome = await tmp.create("swiz-stop-footer-home-")
    const sessionId = "test-footer-incomplete-session"
    const tasksDir = getSessionTasksDir(sessionId, fakeHome)
    if (!tasksDir) throw new Error("Failed to resolve session tasks directory")
    await mkdir(tasksDir, { recursive: true })
    await writeFile(
      join(tasksDir, "task-1.json"),
      JSON.stringify({ id: "task-1", status: "in_progress", subject: "Unfinished work" })
    )
    const result = await runStopHook(
      "stop-incomplete-tasks.ts",
      { cwd: process.cwd(), session_id: sessionId, transcript_path: "" },
      { env: { HOME: fakeHome } }
    )
    expect(result.blocked).toBe(true)
    expect(result.reason).toContain(FOOTER_MARKER)
  })

  test("stop-lockfile-drift: package.json changed without lockfile update block includes footer", async () => {
    // Unique session ID avoids the per-session sentinel blocking a re-run
    const sessionId = `test-footer-lockfile-${Date.now()}`
    const dir = await makeTempGitRepo(tmp, { suffix: "-lockfile" })
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
