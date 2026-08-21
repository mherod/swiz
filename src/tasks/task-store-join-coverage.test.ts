/**
 * No new `join(tasksDir, sessionId)` may appear without the containment guard.
 *
 * The first fix for this class of bug routed one file through the guard and left ten others
 * unguarded, because nothing failed when a call site was missed. This scan is that failure: it
 * lists every place a session id becomes a store path and requires each one to sit next to a
 * guard, so the coverage cannot silently rot again.
 *
 * It is deliberately structural. The behavioural half lives in `task-store-containment.test.ts`;
 * this half only answers "did anyone add a new unguarded join?".
 */

import { describe, expect, test } from "bun:test"
import { readdir, readFile } from "node:fs/promises"
import { join, relative } from "node:path"

const SRC_ROOT = join(import.meta.dir, "..")

/** `join(<something>tasksDir, <something>session...)` in any casing. */
const JOIN_RE = /join\(\s*[A-Za-z_.]*[Tt]asksDir\s*,\s*[A-Za-z_.]*[Ss]ession[A-Za-z_]*\s*[,)]/g
/** A containment call anywhere nearby counts as guarded. */
const GUARD_RE = /isSafeSessionId|sessionDirPath/
/** Lines of context above a join that may carry its guard. */
const GUARD_WINDOW = 12

/**
 * The guard's own definition builds the path it protects, so it cannot be guarded by itself.
 * Test files construct fixture paths directly and are exercising the guard, not bypassing it.
 */
const EXEMPT = new Set(["tasks/task-store-path.ts"])

async function* walkTypeScript(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      yield* walkTypeScript(full)
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      yield full
    }
  }
}

interface JoinSite {
  file: string
  line: number
  text: string
  guarded: boolean
}

async function findJoinSites(): Promise<JoinSite[]> {
  const sites: JoinSite[] = []
  for await (const file of walkTypeScript(SRC_ROOT)) {
    const rel = relative(SRC_ROOT, file)
    if (rel.includes(".test.")) continue
    if (EXEMPT.has(rel)) continue
    const lines = (await readFile(file, "utf-8")).split("\n")
    for (const [index, text] of lines.entries()) {
      JOIN_RE.lastIndex = 0
      if (!JOIN_RE.test(text)) continue
      const window = lines.slice(Math.max(0, index - GUARD_WINDOW), index + 1).join("\n")
      sites.push({ file: rel, line: index + 1, text: text.trim(), guarded: GUARD_RE.test(window) })
    }
  }
  return sites
}

describe("task-store join coverage", () => {
  test("every join(tasksDir, sessionId) sits behind the containment guard", async () => {
    const unguarded = (await findJoinSites()).filter((site) => !site.guarded)
    expect(unguarded.map((s) => `${s.file}:${s.line}  ${s.text}`)).toEqual([])
  })

  test("control: the scanner actually finds join sites and can see an unguarded one", async () => {
    const sites = await findJoinSites()
    // If this drops to zero the first test passes vacuously — the scan found nothing to check.
    expect(sites.length).toBeGreaterThan(0)
    // And the guarded/unguarded distinction must be real, not always-true.
    const sample = "  const dir = join(tasksDir, sessionId)"
    JOIN_RE.lastIndex = 0
    expect(JOIN_RE.test(sample)).toBe(true)
    expect(GUARD_RE.test(sample)).toBe(false)
  })
})
