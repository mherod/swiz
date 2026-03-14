import { afterAll } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getSessionTasksDir } from "./hook-utils.ts"

/**
 * Concurrent-safe temporary directory manager for bun tests.
 *
 * Registers an afterAll hook so directories are removed after ALL tests in the
 * file complete — not after each individual test. This prevents concurrent
 * sibling tests from having their directories deleted mid-run, which causes
 * ENOENT errors in Bun.spawn({ cwd }) calls.
 *
 * Usage:
 *   const tmp = useTempDir("swiz-my-prefix-")
 *   const dir = await tmp.create()          // uses default prefix
 *   const dir = await tmp.create("other-")  // override prefix for this dir
 */
export function useTempDir(defaultPrefix = "swiz-test-") {
  const dirs: string[] = []

  afterAll(async () => {
    while (dirs.length > 0) {
      const dir = dirs.pop()!
      await rm(dir, { recursive: true, force: true })
    }
  })

  return {
    async create(prefix = defaultPrefix): Promise<string> {
      const dir = await mkdtemp(join(tmpdir(), prefix))
      dirs.push(dir)
      return dir
    },
  }
}

export interface HookResult {
  exitCode: number | null
  stdout: string
  stderr: string
  decision?: string
  reason?: string
}

/**
 * Run a hook script as a subprocess with controlled env.
 * Returns parsed hookSpecificOutput decision if present.
 */
export async function runHook(
  script: string,
  stdinPayload: Record<string, unknown>,
  envOverrides: Record<string, string | undefined> = {}
): Promise<HookResult> {
  const payload = JSON.stringify(stdinPayload)
  const env: Record<string, string | undefined> = { ...process.env, ...envOverrides }

  const proc = Bun.spawn(["bun", script], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env,
  })
  void proc.stdin.write(payload)
  void proc.stdin.end()

  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  await proc.exited

  let decision: string | undefined
  let reason: string | undefined

  if (stdout.trim()) {
    try {
      const parsed = JSON.parse(stdout.trim())
      const hso = parsed.hookSpecificOutput as Record<string, unknown> | undefined
      decision = (hso?.permissionDecision ?? parsed.decision) as string | undefined
      reason = (hso?.permissionDecisionReason ?? parsed.reason) as string | undefined
    } catch {}
  }

  return { exitCode: proc.exitCode, stdout: stdout.trim(), stderr, decision, reason }
}

/** Write a task JSON file into ~/.claude/tasks/<sessionId>/<id>.json */
export async function writeTask(
  homeDir: string,
  sessionId: string,
  task: { id: string; subject: string; status: string }
): Promise<void> {
  const dir = getSessionTasksDir(sessionId, homeDir)
  if (!dir) throw new Error("Failed to resolve session tasks directory")
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, `${task.id}.json`),
    JSON.stringify({ ...task, description: "", blocks: [], blockedBy: [] }, null, 2)
  )
}
