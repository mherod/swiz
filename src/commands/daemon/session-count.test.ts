/**
 * `sessionCount` must describe the project, not the scan window.
 *
 * It was computed from `withMessages`, which is drawn from the first `limit * 2` discovered
 * sessions, so it saturated at that cap: three projects holding 2252, 170 and 24 sessions all
 * reported the same number, which reads as the dashboard mixing projects up.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { projectKeyFromCwd } from "../../project-key.ts"
import { acquireEnvLock, releaseEnvLockFn } from "../../utils/test-utils.ts"
import { listProjectSessions } from "./session-data.ts"

const PROJECT_CWD = "/Users/nobody/Development/session-count-fixture"

const tempHomes: string[] = []

afterEach(async () => {
  for (const home of tempHomes.splice(0)) await rm(home, { recursive: true, force: true })
})

/** Build a temp HOME holding `count` Claude sessions, each with one real user message. */
async function seedSessions(count: number): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "swiz-session-count-"))
  tempHomes.push(home)
  const projectDir = join(home, ".claude", "projects", projectKeyFromCwd(PROJECT_CWD))
  mkdirSync(projectDir, { recursive: true })
  for (let i = 0; i < count; i++) {
    const entry = {
      type: "user",
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
      message: { role: "user", content: [{ type: "text", text: `message ${i}` }] },
    }
    await writeFile(join(projectDir, `session-${i}.jsonl`), `${JSON.stringify(entry)}\n`)
  }
  return home
}

describe("listProjectSessions sessionCount", () => {
  test("reports every session in the project, not just the scanned window", async () => {
    await acquireEnvLock()
    const originalHome = process.env.HOME
    try {
      const seeded = 7
      process.env.HOME = await seedSessions(seeded)
      // limit 1 makes the old scan window `limit * 2` = 2, well below the 7 seeded sessions.
      const result = await listProjectSessions(PROJECT_CWD, 1)
      expect(result.sessionCount).toBe(seeded)
      // Control: the visible list still honours the limit, so the count is not simply the list.
      expect(result.sessions.length).toBeLessThan(seeded)
    } finally {
      process.env.HOME = originalHome
      releaseEnvLockFn()
    }
  })

  test("two projects of different sizes do not report the same count", async () => {
    await acquireEnvLock()
    const originalHome = process.env.HOME
    try {
      process.env.HOME = await seedSessions(3)
      const small = await listProjectSessions(PROJECT_CWD, 1)
      process.env.HOME = await seedSessions(9)
      const large = await listProjectSessions(PROJECT_CWD, 1)
      expect(small.sessionCount).toBe(3)
      expect(large.sessionCount).toBe(9)
      expect(small.sessionCount).not.toBe(large.sessionCount)
    } finally {
      process.env.HOME = originalHome
      releaseEnvLockFn()
    }
  })
})
