/**
 * Static analysis test: any test file that mutates the process-global
 * `process.env.HOME` must serialize that window with the shared env lock
 * (`acquireEnvLock`/`releaseEnvLockFn` from src/utils/test-utils.ts), or the
 * mutation bleeds into every other test file running under `bun test --concurrent`.
 *
 * This codifies the CLAUDE.md rule "DON'T mutate process.env.HOME ... in concurrent
 * tests" so new violations cannot be added silently (the absence of this check is
 * how the bleed grew from ~44 to ~153 failures — see issue #680).
 *
 * EXEMPT_HOME_FILES is the shrinking backlog of pre-existing offenders. Converting
 * a file to the env lock (or otherwise removing its global HOME mutation) means
 * deleting its entry here. The goal is an empty allowlist; see #680.
 */

import { describe, expect, test } from "bun:test"
import { readdir } from "node:fs/promises"
import { join } from "node:path"

const ROOT = join(import.meta.dir, "..")
const SCAN_DIRS = ["src", "hooks"]

// Assignment to process.env.HOME (not `==`/`===` comparison, not `delete`).
const HOME_MUTATION_RE = /process\.env\.HOME\s*=(?!=)/

// Pre-existing offenders awaiting conversion to the env lock — tracked by #680.
// DO NOT add to this list. Convert the file to acquireEnvLock/releaseEnvLockFn instead.
const EXEMPT_HOME_FILES = new Set([
  "hooks/pretooluse-apply-rsc-gate.test.ts",
  "hooks/stop-auto-continue.test.ts",
  "src/commands/memory.test.ts",
  "src/commands/tasks.test.ts",
  "src/dispatch/execute.test.ts",
  "src/tasks/codex-update-plan.test.ts",
])

async function collectTestFiles(): Promise<string[]> {
  const out: string[] = []
  for (const dir of SCAN_DIRS) {
    const entries = await readdir(join(ROOT, dir), { recursive: true })
    for (const entry of entries) {
      if (entry.endsWith(".test.ts")) out.push(`${dir}/${entry}`)
    }
  }
  return out
}

describe("process.env.HOME mutation enforcement", () => {
  test("HOME-mutating test files serialize with the env lock", async () => {
    const files = await collectTestFiles()
    const violations: string[] = []

    for (const rel of files) {
      const src = await Bun.file(join(ROOT, rel)).text()
      if (!HOME_MUTATION_RE.test(src)) continue
      if (src.includes("acquireEnvLock")) continue
      if (EXEMPT_HOME_FILES.has(rel)) continue
      violations.push(rel)
    }

    expect(
      violations,
      `These test files mutate process.env.HOME without the env lock. Use ` +
        `acquireEnvLock()/releaseEnvLockFn() from src/utils/test-utils.ts: ${violations.join(", ")}`
    ).toEqual([])
  })

  test("every allowlisted offender still exists and still needs the exemption", async () => {
    // Keeps the #680 backlog honest: once a file is converted (no longer mutates
    // HOME without the lock), its stale allowlist entry must be removed.
    const stale: string[] = []
    for (const rel of EXEMPT_HOME_FILES) {
      const file = Bun.file(join(ROOT, rel))
      if (!(await file.exists())) {
        stale.push(`${rel} (missing)`)
        continue
      }
      const src = await file.text()
      const stillNeeds = HOME_MUTATION_RE.test(src) && !src.includes("acquireEnvLock")
      if (!stillNeeds) stale.push(`${rel} (no longer needs exemption — remove it)`)
    }
    expect(stale).toEqual([])
  })
})
