import { describe, expect, test } from "bun:test"
import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { neutralAgentEnv, useTempDir } from "./test-utils.ts"

// PROCESS_CONTRACT_TEST: runs other suites in a child `bun test` whose HOME stands in for the
// developer's real home, then checks that home's task root. In-process checks cannot see this:
// the leak is whatever a suite writes through the ambient HOME.
//
// #924: these suites wrote fixture tasks ("Push branch to remote", "subject", …) into the real
// ~/.claude/tasks. The backlog tripped task governance into blocking Edit and Bash, and stale
// in_progress rows consumed the WIP cap.
//
// To audit any selection, run it with HOME set to an empty directory, then point
// SWIZ_TASK_ROOT_GUARD_HOME at that directory and run this file; it checks that home instead.

const REPO_ROOT = join(import.meta.dir, "../..")
const CHILD_FLAG = "SWIZ_TASK_ROOT_GUARD_CHILD"
const AUDITED_HOME = process.env.SWIZ_TASK_ROOT_GUARD_HOME?.trim()

/** Suites that wrote fixture tasks into the running user's task root before #924. */
const LEAK_PRONE_SUITES = [
  "hooks/positive-path-integration.test.ts",
  "src/utils/hook-utils-edge-cases.test.ts",
]

const _tmp = useTempDir("swiz-task-root-guard-")

async function taskRootEntries(home: string): Promise<string[]> {
  try {
    return (await readdir(join(home, ".claude", "tasks"), { recursive: true })).sort()
  } catch {
    return []
  }
}

// The child run must not start another child.
describe.skipIf(process.env[CHILD_FLAG] === "1")("real task root isolation", () => {
  test.skipIf(!!AUDITED_HOME)(
    "leak-prone suites leave the user's task root untouched",
    async () => {
      const home = await _tmp.create("swiz-guard-home-")
      const proc = Bun.spawn(["bun", "test", "--reporter=dots", ...LEAK_PRONE_SUITES], {
        cwd: REPO_ROOT,
        env: neutralAgentEnv({ HOME: home, [CHILD_FLAG]: "1", AI_TEST_NO_BACKEND: "1" }),
        stdout: "pipe",
        stderr: "pipe",
      })
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      await proc.exited

      // The task root first: an unrelated child failure must not hide a leak.
      expect(await taskRootEntries(home)).toEqual([])
      expect({ exitCode: proc.exitCode, tail: `${stdout}${stderr}`.slice(-2000) }).toMatchObject({
        exitCode: 0,
      })
    },
    180_000
  )

  test.skipIf(!AUDITED_HOME)(
    "an audited run left its stand-in home's task root empty",
    async () => {
      expect(await taskRootEntries(AUDITED_HOME!)).toEqual([])
    }
  )
})
