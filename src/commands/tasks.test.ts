import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdir, readFile, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { projectKeyFromCwd } from "../transcript-utils.ts"
import {
  compareTaskIds,
  findTaskAcrossSessions,
  getSessionIdsByCwdScan,
  getSessionIdsForProject,
  getSessions,
  parseTaskId,
  resolveTaskById,
  sessionPrefix,
  tasksCommand,
  verifyTaskSubject,
} from "./tasks.ts"

const TMP = join(tmpdir(), `swiz-tasks-test-${process.pid}-${Date.now()}`)
const TASKS = join(TMP, "tasks")
const PROJECTS = join(TMP, "projects")
const FILTER_CWD = "/Users/test/Development/myproject"

// Serialize tests that modify process.env.HOME or process.chdir
let _queue: Promise<unknown> = Promise.resolve()
async function serial<T>(fn: () => Promise<T>): Promise<T> {
  const result = _queue.then(fn)
  _queue = result.catch(() => {})
  return result
}

// Session IDs
const SESSION_A = "aaaa-aaaa-aaaa"
const SESSION_B = "bbbb-bbbb-bbbb"
const SESSION_C = "cccc-cccc-cccc"

// Clear CLAUDECODE so the native-task-tool guard doesn't block CLI tests
const _savedClaudeCode = process.env.CLAUDECODE
delete process.env.CLAUDECODE

beforeAll(async () => {
  // ── Task directories (3 sessions) ──
  await mkdir(join(TASKS, SESSION_A), { recursive: true })
  await mkdir(join(TASKS, SESSION_B), { recursive: true })
  await mkdir(join(TASKS, SESSION_C), { recursive: true })
  // Write a dummy task file so stat works
  for (const s of [SESSION_A, SESSION_B, SESSION_C]) {
    await writeFile(
      join(TASKS, s, "1.json"),
      JSON.stringify({
        id: "1",
        subject: "Test task",
        description: "desc",
        status: "completed",
        blocks: [],
        blockedBy: [],
      })
    )
  }
  // Write a task #120 only in SESSION_B (simulates compaction-orphaned task)
  await writeFile(
    join(TASKS, SESSION_B, "120.json"),
    JSON.stringify({
      id: "120",
      subject: "Push and verify CI",
      description: "Verify CI after push",
      status: "in_progress",
      blocks: [],
      blockedBy: [],
    })
  )
  // Write task #200 in SESSION_B and SESSION_C (simulates cross-session ID collision)
  for (const s of [SESSION_B, SESSION_C]) {
    await writeFile(
      join(TASKS, s, "200.json"),
      JSON.stringify({
        id: "200",
        subject: s === SESSION_B ? "Deploy staging" : "Deploy production",
        description: "Colliding task ID across sessions",
        status: s === SESSION_B ? "in_progress" : "completed",
        blocks: [],
        blockedBy: [],
      })
    )
  }

  // Write a prefixed task in SESSION_C (simulates session-scoped ID)
  const prefixC = SESSION_C.replace(/-/g, "").slice(0, 4).toLowerCase()
  await writeFile(
    join(TASKS, SESSION_C, `${prefixC}-10.json`),
    JSON.stringify({
      id: `${prefixC}-10`,
      subject: "Prefixed task in session C",
      description: "Session-scoped task ID",
      status: "pending",
      blocks: [],
      blockedBy: [],
    })
  )

  // ── Project directory matching the canonical key ──
  // This directory holds transcripts for SESSION_A only (fast-path match).
  const canonicalKey = projectKeyFromCwd(FILTER_CWD)
  const canonicalDir = join(PROJECTS, canonicalKey)
  await mkdir(canonicalDir, { recursive: true })
  await writeFile(
    join(canonicalDir, `${SESSION_A}.jsonl`),
    `${JSON.stringify({ type: "user", cwd: FILTER_CWD })}\n`
  )

  // ── Alternate project directory (different encoding) ──
  // Simulates an older encoding that doesn't match projectKeyFromCwd().
  // Holds transcripts for SESSION_B and SESSION_C.
  const altDir = join(PROJECTS, "alt-legacy-encoding")
  await mkdir(altDir, { recursive: true })
  await writeFile(
    join(altDir, `${SESSION_B}.jsonl`),
    `${JSON.stringify({ type: "user", cwd: FILTER_CWD })}\n`
  )
  await writeFile(
    join(altDir, `${SESSION_C}.jsonl`),
    `${JSON.stringify({ type: "user", cwd: FILTER_CWD })}\n`
  )
})

afterAll(async () => {
  // Restore CLAUDECODE after all tests
  if (_savedClaudeCode === undefined) delete process.env.CLAUDECODE
  else process.env.CLAUDECODE = _savedClaudeCode

  const { rm } = await import("node:fs/promises")
  await rm(TMP, { recursive: true, force: true })
})

// ─── getSessionIdsForProject ─────────────────────────────────────────────────

describe("getSessionIdsForProject", () => {
  it("returns session IDs from the canonical project directory", async () => {
    const key = projectKeyFromCwd(FILTER_CWD)
    const ids = await getSessionIdsForProject(key, PROJECTS)
    expect(ids.has(SESSION_A)).toBe(true)
    expect(ids.size).toBe(1)
  })

  it("returns empty set for nonexistent project key", async () => {
    const ids = await getSessionIdsForProject("nonexistent-key", PROJECTS)
    expect(ids.size).toBe(0)
  })
})

// ─── getSessionIdsByCwdScan ──────────────────────────────────────────────────

describe("getSessionIdsByCwdScan", () => {
  it("finds sessions by scanning transcript cwd values", async () => {
    const ids = await getSessionIdsByCwdScan(FILTER_CWD, [SESSION_B, SESSION_C], PROJECTS)
    expect(ids.has(SESSION_B)).toBe(true)
    expect(ids.has(SESSION_C)).toBe(true)
    expect(ids.size).toBe(2)
  })

  it("skips candidates not in the candidate list", async () => {
    // SESSION_A exists in canonical dir but is not a candidate
    const ids = await getSessionIdsByCwdScan(FILTER_CWD, [SESSION_B], PROJECTS)
    expect(ids.has(SESSION_B)).toBe(true)
    expect(ids.has(SESSION_A)).toBe(false)
    expect(ids.size).toBe(1)
  })

  it("returns empty set when cwd does not match", async () => {
    const ids = await getSessionIdsByCwdScan("/no/match", [SESSION_A, SESSION_B], PROJECTS)
    expect(ids.size).toBe(0)
  })
})

// ─── getSessions ─────────────────────────────────────────────────────────────

describe("getSessions", () => {
  it("returns all sessions when no filterCwd", async () => {
    const sessions = await getSessions(undefined, TASKS, PROJECTS)
    expect(sessions.sort()).toEqual([SESSION_A, SESSION_B, SESSION_C].sort())
  })

  it("returns only fast-path session when all are under canonical key", async () => {
    // Create a projects dir with only the canonical key containing SESSION_A
    const isolatedProjects = join(TMP, "projects-isolated")
    const key = projectKeyFromCwd(FILTER_CWD)
    await mkdir(join(isolatedProjects, key), { recursive: true })
    await writeFile(
      join(isolatedProjects, key, `${SESSION_A}.jsonl`),
      `${JSON.stringify({ type: "user", cwd: FILTER_CWD })}\n`
    )

    const sessions = await getSessions(FILTER_CWD, TASKS, isolatedProjects)
    expect(sessions).toContain(SESSION_A)
  })

  it("merges fast-path AND fallback sessions (partial match)", async () => {
    // The key test: SESSION_A is under the canonical key (fast path),
    // SESSION_B and SESSION_C are under alt-legacy-encoding (fallback).
    // All three must be returned.
    const sessions = await getSessions(FILTER_CWD, TASKS, PROJECTS)
    expect(sessions).toContain(SESSION_A)
    expect(sessions).toContain(SESSION_B)
    expect(sessions).toContain(SESSION_C)
    expect(sessions.length).toBe(3)
  })

  it("returns empty array when filterCwd matches no sessions", async () => {
    const sessions = await getSessions("/nonexistent/path", TASKS, PROJECTS)
    expect(sessions).toEqual([])
  })

  it("returns all sessions when filterCwd matches no sessions (compaction fallback scenario)", async () => {
    // Simulates post-compaction: task dir exists but transcript hasn't been indexed yet.
    // getSessions("/nonexistent/path") returns [] — callers fall back to getSessions(undefined).
    const noMatch = await getSessions("/nonexistent/path", TASKS, PROJECTS)
    expect(noMatch).toEqual([])
    // The fallback call (undefined filterCwd) still finds all sessions:
    const allSessions = await getSessions(undefined, TASKS, PROJECTS)
    expect(allSessions).toContain(SESSION_A)
    expect(allSessions).toContain(SESSION_B)
    expect(allSessions).toContain(SESSION_C)
    expect(allSessions.length).toBe(3)
  })
})

// ─── verifyTaskSubject ────────────────────────────────────────────────────────

describe("verifyTaskSubject", () => {
  it("passes when verify text is a prefix of the subject", () => {
    expect(verifyTaskSubject("Push and verify CI", "Push and")).toBeNull()
    expect(verifyTaskSubject("Implement feature X", "implement")).toBeNull()
  })

  it("is case-insensitive", () => {
    expect(verifyTaskSubject("Push and verify CI", "PUSH AND")).toBeNull()
    expect(verifyTaskSubject("IMPLEMENT FEATURE", "implement")).toBeNull()
  })

  it("fails when verify text does not match the subject prefix", () => {
    const error = verifyTaskSubject("Push and verify CI", "Fix bug")
    expect(error).not.toBeNull()
    expect(error).toContain("Verification failed")
    expect(error).toContain("Push and verify CI")
  })

  it("matches the full subject exactly", () => {
    expect(verifyTaskSubject("Fix bug", "Fix bug")).toBeNull()
  })
})

// ─── findTaskAcrossSessions ──────────────────────────────────────────────────

describe("findTaskAcrossSessions", () => {
  it("finds a task in a non-primary session", async () => {
    // Task #120 exists only in SESSION_B
    const results = await findTaskAcrossSessions("120", undefined, TASKS, PROJECTS)
    expect(results.length).toBe(1)
    expect(results[0]!.sessionId).toBe(SESSION_B)
    expect(results[0]!.task.id).toBe("120")
    expect(results[0]!.task.subject).toBe("Push and verify CI")
  })

  it("returns all matches when task ID exists in multiple sessions", async () => {
    // Task #1 exists in all three sessions
    const results = await findTaskAcrossSessions("1", undefined, TASKS, PROJECTS)
    expect(results.length).toBe(3)
    const sessionIds = results.map((r) => r.sessionId).sort()
    expect(sessionIds).toEqual([SESSION_A, SESSION_B, SESSION_C].sort())
  })

  it("returns empty array for a nonexistent task ID", async () => {
    const results = await findTaskAcrossSessions("999", undefined, TASKS, PROJECTS)
    expect(results.length).toBe(0)
  })

  it("scopes search to project sessions when filterCwd is provided", async () => {
    // Create an isolated setup where only SESSION_A matches the CWD.
    // SESSION_B and SESSION_C are indexed under a different project key to
    // simulate the real-world case where they belong to other projects —
    // this prevents the compaction-gap fallback from including them.
    const isolatedProjects = join(TMP, "projects-isolated-cross")
    const key = projectKeyFromCwd(FILTER_CWD)
    await mkdir(join(isolatedProjects, key), { recursive: true })
    await writeFile(
      join(isolatedProjects, key, `${SESSION_A}.jsonl`),
      `${JSON.stringify({ type: "user", cwd: FILTER_CWD })}\n`
    )
    const otherKey = "other-project-cross"
    await mkdir(join(isolatedProjects, otherKey), { recursive: true })
    await writeFile(join(isolatedProjects, otherKey, `${SESSION_B}.jsonl`), "\n")
    await writeFile(join(isolatedProjects, otherKey, `${SESSION_C}.jsonl`), "\n")

    // Task #120 is in SESSION_B which is NOT in this project — must not match
    const results = await findTaskAcrossSessions("120", FILTER_CWD, TASKS, isolatedProjects)
    expect(results.length).toBe(0)
  })
})

// ─── resolveTaskById ─────────────────────────────────────────────────────────

describe("resolveTaskById", () => {
  it("resolves from primary session when task exists there", async () => {
    // Task #1 exists in SESSION_A
    const result = await resolveTaskById("1", SESSION_A, undefined, TASKS, PROJECTS)
    expect(result.sessionId).toBe(SESSION_A)
    expect(result.task.id).toBe("1")
  })

  it("falls back to another session when task is not in primary", async () => {
    // Task #120 only exists in SESSION_B — pass SESSION_A as primary
    const result = await resolveTaskById("120", SESSION_A, undefined, TASKS, PROJECTS)
    expect(result.sessionId).toBe(SESSION_B)
    expect(result.task.id).toBe("120")
    expect(result.task.subject).toBe("Push and verify CI")
  })

  it("throws for nonexistent task ID", async () => {
    await expect(resolveTaskById("999", SESSION_A, undefined, TASKS, PROJECTS)).rejects.toThrow(
      "Task #999 not found in any session for this project."
    )
  })

  it("includes recent task IDs in not-found error message", async () => {
    let errorMessage = ""
    try {
      await resolveTaskById("999", SESSION_A, undefined, TASKS, PROJECTS)
    } catch (e) {
      errorMessage = (e as Error).message
    }
    expect(errorMessage).toContain("Recent tasks in this session:")
    // Should list tasks from SESSION_A with their IDs and subjects
    expect(errorMessage).toMatch(/#\d+ \[(pending|in_progress|completed|cancelled)\]:/)
  })

  it("prefers primary session over fallback for same task ID", async () => {
    // Task #1 exists in all sessions — primary should win
    const result = await resolveTaskById("1", SESSION_C, undefined, TASKS, PROJECTS)
    expect(result.sessionId).toBe(SESSION_C)
  })

  it("throws disambiguation error when task ID collides across sessions", async () => {
    // Task #200 exists in SESSION_B and SESSION_C but not SESSION_A
    await expect(resolveTaskById("200", SESSION_A, undefined, TASKS, PROJECTS)).rejects.toThrow(
      /Task #200 exists in 2 sessions/
    )
  })

  it("disambiguation error includes session details", async () => {
    try {
      await resolveTaskById("200", SESSION_A, undefined, TASKS, PROJECTS)
      expect.unreachable("should have thrown")
    } catch (err: unknown) {
      const msg = (err as Error).message
      expect(msg).toContain("--session")
      expect(msg).toContain("Deploy staging")
      expect(msg).toContain("Deploy production")
    }
  })

  it("resolves prefixed task ID directly via session prefix", async () => {
    const prefixC = sessionPrefix(SESSION_C)
    const result = await resolveTaskById(`${prefixC}-10`, SESSION_A, undefined, TASKS, PROJECTS)
    expect(result.sessionId).toBe(SESSION_C)
    expect(result.task.subject).toBe("Prefixed task in session C")
  })

  it("throws for prefixed ID with no matching session", async () => {
    await expect(resolveTaskById("zzzz-99", SESSION_A, undefined, TASKS, PROJECTS)).rejects.toThrow(
      /no session with prefix "zzzz" exists in this project/
    )
  })

  it("includes recent session IDs in no-session error for agent recovery", async () => {
    // The error should inline session IDs so the agent can recover without running swiz tasks.
    try {
      await resolveTaskById("zzzz-99", SESSION_A, undefined, TASKS, PROJECTS)
      expect.unreachable("should have thrown")
    } catch (err: unknown) {
      const msg = (err as Error).message
      // At least one known session prefix should appear inline
      const knownPrefix = SESSION_A.slice(0, 8)
      expect(msg).toContain(knownPrefix)
    }
  })

  it("throws distinct error when session matches prefix but task file is absent", async () => {
    // SESSION_C exists and has prefix cccc, but task cccc-99 was never written.
    const prefixC = sessionPrefix(SESSION_C)
    try {
      await resolveTaskById(`${prefixC}-99`, SESSION_A, undefined, TASKS, PROJECTS)
      expect.unreachable("should have thrown")
    } catch (err: unknown) {
      const msg = (err as Error).message
      // Must name the matched session (not claim no session exists)
      expect(msg).toContain(SESSION_C.slice(0, 8))
      // Must give actionable guidance
      expect(msg).toContain("--session")
      // Must NOT say "matched no session" (the old misleading message)
      expect(msg).not.toContain("matched no session")
    }
  })

  it("hint on session-found-but-task-absent uses matching session tasks, not primary", async () => {
    // Verify buildRecentTasksHint is called with matchingSession, not primarySessionId.
    // SESSION_C has task cccc-10 but not cccc-99. The hint should reference cccc-10.
    const prefixC = sessionPrefix(SESSION_C)
    try {
      await resolveTaskById(`${prefixC}-99`, SESSION_A, undefined, TASKS, PROJECTS)
      expect.unreachable("should have thrown")
    } catch (err: unknown) {
      const msg = (err as Error).message
      // The hint should list tasks from SESSION_C (which has cccc-10)
      expect(msg).toContain("Prefixed task in session C")
    }
  })

  // ── filterCwd scope-parity tests (regression for #193) ──────────────────────
  // Before the fix, the prefixed ID path called getSessions(undefined,...) and
  // ignored filterCwd, letting it resolve tasks outside the current project.
  // After the fix both paths honour the same filterCwd scope.

  it("prefixed ID respects filterCwd — rejects task outside scoped sessions", async () => {
    // Isolated projects dir: only SESSION_A is mapped to FILTER_CWD.
    // SESSION_B and SESSION_C are indexed under a different project key to
    // simulate the real-world case where they belong to other projects —
    // this prevents the compaction-gap fallback from including them.
    const scopedProjects = join(TMP, "projects-scope-parity")
    const key = projectKeyFromCwd(FILTER_CWD)
    await mkdir(join(scopedProjects, key), { recursive: true })
    await writeFile(
      join(scopedProjects, key, `${SESSION_A}.jsonl`),
      `${JSON.stringify({ type: "user", cwd: FILTER_CWD })}\n`
    )
    const otherKey1 = "other-project-scope-parity"
    await mkdir(join(scopedProjects, otherKey1), { recursive: true })
    await writeFile(join(scopedProjects, otherKey1, `${SESSION_B}.jsonl`), "\n")
    await writeFile(join(scopedProjects, otherKey1, `${SESSION_C}.jsonl`), "\n")

    const prefixC = sessionPrefix(SESSION_C)
    // SESSION_C is outside the scoped project — should throw
    await expect(
      resolveTaskById(`${prefixC}-10`, SESSION_A, FILTER_CWD, TASKS, scopedProjects)
    ).rejects.toThrow()
  })

  it("unprefixed ID also respects filterCwd — rejects task outside scoped sessions", async () => {
    // Mirror test for unprefixed path: task #120 lives in SESSION_B which is NOT
    // in scopedProjects2 (only SESSION_A is). Must throw, not return SESSION_B's task.
    // SESSION_B and SESSION_C are indexed under a different project key to
    // simulate the real-world case where they belong to other projects.
    const scopedProjects2 = join(TMP, "projects-scope-parity-2")
    const key = projectKeyFromCwd(FILTER_CWD)
    await mkdir(join(scopedProjects2, key), { recursive: true })
    await writeFile(
      join(scopedProjects2, key, `${SESSION_A}.jsonl`),
      `${JSON.stringify({ type: "user", cwd: FILTER_CWD })}\n`
    )
    const otherKey2 = "other-project-scope-parity-2"
    await mkdir(join(scopedProjects2, otherKey2), { recursive: true })
    await writeFile(join(scopedProjects2, otherKey2, `${SESSION_B}.jsonl`), "\n")
    await writeFile(join(scopedProjects2, otherKey2, `${SESSION_C}.jsonl`), "\n")

    // Task #120 only exists in SESSION_B — which is excluded by filterCwd
    await expect(
      resolveTaskById("120", SESSION_A, FILTER_CWD, TASKS, scopedProjects2)
    ).rejects.toThrow()
  })

  it("both ID forms agree on scope — same project, same result", async () => {
    // When both SESSION_A and SESSION_C are in scope, the prefixed path and the
    // unprefixed path should both find their respective tasks.
    // Reuse the shared PROJECTS dir (SESSION_A via canonicalKey, SESSION_C via altDir).

    // Unprefixed: task #1 in SESSION_A resolves correctly under FILTER_CWD
    const unprefixedResult = await resolveTaskById("1", SESSION_A, FILTER_CWD, TASKS, PROJECTS)
    expect(unprefixedResult.sessionId).toBe(SESSION_A)
    expect(unprefixedResult.task.id).toBe("1")

    // Prefixed: cccc-10 in SESSION_C resolves correctly under FILTER_CWD (SESSION_C is in scope)
    const prefixC = sessionPrefix(SESSION_C)
    const prefixedResult = await resolveTaskById(
      `${prefixC}-10`,
      SESSION_A,
      FILTER_CWD,
      TASKS,
      PROJECTS
    )
    expect(prefixedResult.sessionId).toBe(SESSION_C)
    expect(prefixedResult.task.subject).toBe("Prefixed task in session C")
  })
})

// ─── sessionPrefix ──────────────────────────────────────────────────────────

describe("sessionPrefix", () => {
  it("extracts first 4 hex chars from UUID", () => {
    expect(sessionPrefix("aaaa-aaaa-aaaa")).toBe("aaaa")
    expect(sessionPrefix("AbCd-1234-5678")).toBe("abcd")
  })

  it("handles short session IDs", () => {
    expect(sessionPrefix("ab")).toBe("ab")
    expect(sessionPrefix("")).toBe("")
  })
})

// ─── parseTaskId ────────────────────────────────────────────────────────────

describe("parseTaskId", () => {
  it("parses plain numeric IDs", () => {
    const { prefix, seq } = parseTaskId("42")
    expect(prefix).toBeNull()
    expect(seq).toBe(42)
  })

  it("parses prefixed IDs", () => {
    const { prefix, seq } = parseTaskId("a3f2-5")
    expect(prefix).toBe("a3f2")
    expect(seq).toBe(5)
  })

  it("handles multi-digit sequences", () => {
    const { prefix, seq } = parseTaskId("b7c1-123")
    expect(prefix).toBe("b7c1")
    expect(seq).toBe(123)
  })
})

// ─── compareTaskIds ─────────────────────────────────────────────────────────

describe("compareTaskIds", () => {
  it("sorts numeric IDs numerically", () => {
    const ids = ["3", "1", "10", "2"]
    expect(ids.sort(compareTaskIds)).toEqual(["1", "2", "3", "10"])
  })

  it("places numeric IDs before prefixed IDs", () => {
    const ids = ["a3f2-1", "1", "b7c1-2"]
    expect(ids.sort(compareTaskIds)).toEqual(["1", "a3f2-1", "b7c1-2"])
  })

  it("sorts prefixed IDs by prefix then sequence", () => {
    const ids = ["b7c1-2", "a3f2-3", "a3f2-1", "b7c1-1"]
    expect(ids.sort(compareTaskIds)).toEqual(["a3f2-1", "a3f2-3", "b7c1-1", "b7c1-2"])
  })
})

// ─── complete --dry-run validation ──────────────────────────────────────────
// The dry-run path calls resolveTaskById for the given ID and reports
// whether the task exists — without writing or mutating anything.

describe("complete --dry-run: resolveTaskById validation", () => {
  it("resolves a task that exists in the session", async () => {
    // Task #1 exists in SESSION_A — resolution should succeed
    const result = await resolveTaskById("1", SESSION_A, FILTER_CWD, TASKS, PROJECTS)
    expect(result.task.id).toBe("1")
    expect(result.task.subject).toBe("Test task")
  })

  it("throws 'not found' for a task ID that does not exist", async () => {
    await expect(resolveTaskById("9999", SESSION_A, FILTER_CWD, TASKS, PROJECTS)).rejects.toThrow(
      /not found/
    )
  })

  it("throws for a missing task even when session is valid", async () => {
    // SESSION_B has task 120 but not task 999
    await expect(resolveTaskById("999", SESSION_B, FILTER_CWD, TASKS, PROJECTS)).rejects.toThrow(
      /not found/
    )
  })

  it("does not write any files during dry-run validation", async () => {
    // Resolution of an existing task is pure read — no side effects
    const { readdir } = await import("node:fs/promises")
    const before = await readdir(join(TASKS, SESSION_A))
    await resolveTaskById("1", SESSION_A, FILTER_CWD, TASKS, PROJECTS)
    const after = await readdir(join(TASKS, SESSION_A))
    expect(after).toEqual(before)
  })
})

// ─── Issue #242 regressions ───────────────────────────────────────────────────

describe("tasks command regressions (#242)", () => {
  it("status updates without --state when explicit session is provided", async () => {
    await serial(async () => {
      const home = join(TMP, "issue-242-home-status")
      const repoCwd = join(TMP, "issue-242-repo-status")
      const sessionId = "11111111-aaaa-bbbb-cccc-000000000001"
      const taskId = "1"
      const taskPath = join(home, ".claude", "tasks", sessionId, `${taskId}.json`)

      await mkdir(join(home, ".claude", "tasks", sessionId), { recursive: true })
      await mkdir(repoCwd, { recursive: true })
      await writeFile(
        taskPath,
        JSON.stringify({
          id: taskId,
          subject: "Finish task",
          description: "desc",
          status: "in_progress",
          statusChangedAt: new Date().toISOString(),
          elapsedMs: 0,
          blocks: [],
          blockedBy: [],
        })
      )

      const prevHome = process.env.HOME
      const prevCwd = process.cwd()
      process.env.HOME = home
      process.chdir(repoCwd)
      try {
        await Promise.resolve(
          tasksCommand.run([
            "status",
            taskId,
            "completed",
            "--session",
            sessionId,
            "--evidence",
            "note:completed",
          ])
        )
      } finally {
        process.chdir(prevCwd)
        if (prevHome === undefined) {
          delete process.env.HOME
        } else {
          process.env.HOME = prevHome
        }
      }

      const updated = JSON.parse(await readFile(taskPath, "utf8")) as { status: string }
      expect(updated.status).toBe("completed")
    })
  })
})

describe("task timing fields (#267)", () => {
  it("sets startedAt when a task enters in_progress", async () => {
    await serial(async () => {
      const home = join(TMP, "issue-267-home-started-at")
      const repoCwd = join(TMP, "issue-267-repo-started-at")
      const sessionId = "66666666-aaaa-bbbb-cccc-000000000001"
      const taskId = "1"
      const taskPath = join(home, ".claude", "tasks", sessionId, `${taskId}.json`)

      await mkdir(join(home, ".claude", "tasks", sessionId), { recursive: true })
      await mkdir(repoCwd, { recursive: true })
      await writeFile(
        taskPath,
        JSON.stringify({
          id: taskId,
          subject: "Start task timing",
          description: "desc",
          status: "pending",
          startedAt: null,
          completedAt: null,
          statusChangedAt: new Date().toISOString(),
          elapsedMs: 0,
          blocks: [],
          blockedBy: [],
        })
      )

      const prevHome = process.env.HOME
      const prevCwd = process.cwd()
      process.env.HOME = home
      process.chdir(repoCwd)
      try {
        await expect(
          tasksCommand.run(["status", taskId, "in_progress", "--session", sessionId])
        ).resolves.toBeUndefined()
      } finally {
        process.chdir(prevCwd)
        if (prevHome === undefined) delete process.env.HOME
        else process.env.HOME = prevHome
      }

      const updated = JSON.parse(await readFile(taskPath, "utf8")) as {
        status: string
        startedAt: number | null
        completedAt: number | null
      }
      expect(updated.status).toBe("in_progress")
      expect(typeof updated.startedAt).toBe("number")
      expect(updated.completedAt).toBeNull()
    })
  })

  it("sets completedAt when a task enters completed", async () => {
    await serial(async () => {
      const home = join(TMP, "issue-267-home-completed-at")
      const repoCwd = join(TMP, "issue-267-repo-completed-at")
      const sessionId = "77777777-aaaa-bbbb-cccc-000000000001"
      const taskId = "1"
      const taskPath = join(home, ".claude", "tasks", sessionId, `${taskId}.json`)
      const startedAt = Date.now() - 60_000

      await mkdir(join(home, ".claude", "tasks", sessionId), { recursive: true })
      await mkdir(repoCwd, { recursive: true })
      await writeFile(
        taskPath,
        JSON.stringify({
          id: taskId,
          subject: "Finish task timing",
          description: "desc",
          status: "in_progress",
          startedAt,
          completedAt: null,
          statusChangedAt: new Date(startedAt).toISOString(),
          elapsedMs: 0,
          blocks: [],
          blockedBy: [],
        })
      )

      const prevHome = process.env.HOME
      const prevCwd = process.cwd()
      process.env.HOME = home
      process.chdir(repoCwd)
      try {
        await Promise.resolve(
          tasksCommand.run([
            "status",
            taskId,
            "completed",
            "--session",
            sessionId,
            "--evidence",
            "note:completed with timing",
          ])
        )
      } finally {
        process.chdir(prevCwd)
        if (prevHome === undefined) delete process.env.HOME
        else process.env.HOME = prevHome
      }

      const updated = JSON.parse(await readFile(taskPath, "utf8")) as {
        status: string
        startedAt: number | null
        completedAt: number | null
        completionTimestamp?: string
      }
      expect(updated.status).toBe("completed")
      expect(updated.startedAt).toBe(startedAt)
      expect(typeof updated.completedAt).toBe("number")
      expect(updated.completedAt).toBeGreaterThanOrEqual(startedAt)
      expect(updated.completionTimestamp).toBeTruthy()
    })
  })
})

describe("native task recovery paths (#271)", () => {
  it("complete creates placeholder stub when --subject is omitted", async () => {
    await serial(async () => {
      const home = join(TMP, "issue-271-home-complete-placeholder")
      const repoCwd = join(TMP, "issue-271-repo-complete-placeholder")
      const sessionId = "44444444-aaaa-bbbb-cccc-000000000001"
      const taskId = "42"
      const taskPath = join(home, ".claude", "tasks", sessionId, `${taskId}.json`)

      await mkdir(join(home, ".claude", "tasks", sessionId), { recursive: true })
      await mkdir(repoCwd, { recursive: true })

      const prevHome = process.env.HOME
      const prevCwd = process.cwd()
      process.env.HOME = home
      process.chdir(repoCwd)
      try {
        await expect(
          tasksCommand.run([
            "complete",
            taskId,
            "--session",
            sessionId,
            "--state",
            "developing",
            "--evidence",
            "note:completed from recovery",
          ])
        ).resolves.toBeUndefined()
      } finally {
        process.chdir(prevCwd)
        if (prevHome === undefined) delete process.env.HOME
        else process.env.HOME = prevHome
      }

      const recovered = JSON.parse(await readFile(taskPath, "utf8")) as {
        subject: string
        status: string
        completionEvidence?: string
      }
      expect(recovered.subject).toBe(`Task #${taskId}`)
      expect(recovered.status).toBe("completed")
      expect(recovered.completionEvidence).toBe("note:completed from recovery")
    })
  })

  it("status creates stub from --subject for missing task", async () => {
    await serial(async () => {
      const home = join(TMP, "issue-271-home-status")
      const repoCwd = join(TMP, "issue-271-repo-status")
      const sessionId = "66666666-aaaa-bbbb-cccc-000000000001"
      const taskId = "88"
      const taskPath = join(home, ".claude", "tasks", sessionId, `${taskId}.json`)

      await mkdir(join(home, ".claude", "tasks", sessionId), { recursive: true })
      await mkdir(repoCwd, { recursive: true })

      const prevHome = process.env.HOME
      const prevCwd = process.cwd()
      process.env.HOME = home
      process.chdir(repoCwd)
      try {
        await expect(
          tasksCommand.run([
            "status",
            taskId,
            "completed",
            "--session",
            sessionId,
            "--subject",
            "Recovered status task",
            "--state",
            "developing",
            "--evidence",
            "note:status recovered",
          ])
        ).resolves.toBeUndefined()
      } finally {
        process.chdir(prevCwd)
        if (prevHome === undefined) delete process.env.HOME
        else process.env.HOME = prevHome
      }

      const recovered = JSON.parse(await readFile(taskPath, "utf8")) as {
        subject: string
        status: string
      }
      expect(recovered.subject).toBe("Recovered status task")
      expect(recovered.status).toBe("completed")
    })
  })

  it("update creates stub from --subject for missing task", async () => {
    await serial(async () => {
      const home = join(TMP, "issue-271-home-update")
      const repoCwd = join(TMP, "issue-271-repo-update")
      const sessionId = "77777777-aaaa-bbbb-cccc-000000000001"
      const taskId = "99"
      const taskPath = join(home, ".claude", "tasks", sessionId, `${taskId}.json`)

      await mkdir(join(home, ".claude", "tasks", sessionId), { recursive: true })
      await mkdir(repoCwd, { recursive: true })

      const prevHome = process.env.HOME
      const prevCwd = process.cwd()
      process.env.HOME = home
      process.chdir(repoCwd)
      try {
        await expect(
          tasksCommand.run([
            "update",
            taskId,
            "--session",
            sessionId,
            "--subject",
            "Recovered update task",
            "--description",
            "Recovered description",
            "--status",
            "pending",
          ])
        ).resolves.toBeUndefined()
      } finally {
        process.chdir(prevCwd)
        if (prevHome === undefined) delete process.env.HOME
        else process.env.HOME = prevHome
      }

      const recovered = JSON.parse(await readFile(taskPath, "utf8")) as {
        subject: string
        description: string
        status: string
      }
      expect(recovered.subject).toBe("Recovered update task")
      expect(recovered.description).toBe("Recovered description")
      expect(recovered.status).toBe("pending")
    })
  })
})

// ─── printPreviousSessionIncompleteHint — native tool hint (#290) ────────────

describe("printPreviousSessionIncompleteHint native tool hint (#290)", () => {
  it("shows native tool hint when running inside an agent", async () => {
    await serial(async () => {
      const home = join(TMP, "issue-290-hint-agent")
      const repoCwdRaw = join(TMP, "issue-290-repo-agent")
      const currentSession = "11111111-2222-3333-4444-aaaaaaaaaaaa"
      const prevSession = "11111111-2222-3333-4444-bbbbbbbbbbbb"

      await mkdir(repoCwdRaw, { recursive: true })

      // chdir first to get the canonical cwd (macOS resolves /var → /private/var)
      const prevCwd = process.cwd()
      process.chdir(repoCwdRaw)
      const repoCwd = process.cwd()

      // Test uses GEMINI_CLI=1, so task store resolves to .gemini/ paths
      const agentDir = ".gemini"
      const projKey = projectKeyFromCwd(repoCwd)
      await mkdir(join(home, agentDir, "projects", projKey), { recursive: true })
      await writeFile(
        join(home, agentDir, "projects", projKey, `${currentSession}.jsonl`),
        `${JSON.stringify({ type: "user", cwd: repoCwd })}\n`
      )
      await writeFile(
        join(home, agentDir, "projects", projKey, `${prevSession}.jsonl`),
        `${JSON.stringify({ type: "user", cwd: repoCwd })}\n`
      )

      // Previous session: has incomplete task (created first → older mtime)
      await mkdir(join(home, agentDir, "tasks", prevSession), { recursive: true })
      await writeFile(
        join(home, agentDir, "tasks", prevSession, "1.json"),
        JSON.stringify({
          id: "1",
          subject: "Incomplete task",
          description: "",
          status: "in_progress",
          blocks: [],
          blockedBy: [],
        })
      )
      const oldTime = new Date(Date.now() - 60_000)
      await utimes(join(home, agentDir, "tasks", prevSession), oldTime, oldTime)

      // Current session: all tasks completed (created second → newer mtime)
      await mkdir(join(home, agentDir, "tasks", currentSession), { recursive: true })
      await writeFile(
        join(home, agentDir, "tasks", currentSession, "1.json"),
        JSON.stringify({
          id: "1",
          subject: "Done task",
          description: "",
          status: "completed",
          blocks: [],
          blockedBy: [],
        })
      )

      const prevHome = process.env.HOME
      const prevGemini = process.env.GEMINI_CLI
      const prevClaudeCode = process.env.CLAUDECODE
      process.env.HOME = home
      process.env.GEMINI_CLI = "1"
      delete process.env.CLAUDECODE

      const logs: string[] = []
      const origLog = console.log
      console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "))

      try {
        await tasksCommand.run([])
      } finally {
        console.log = origLog
        process.chdir(prevCwd)
        if (prevHome === undefined) delete process.env.HOME
        else process.env.HOME = prevHome
        if (prevGemini === undefined) delete process.env.GEMINI_CLI
        else process.env.GEMINI_CLI = prevGemini
        if (prevClaudeCode === undefined) delete process.env.CLAUDECODE
        else process.env.CLAUDECODE = prevClaudeCode
      }

      const output = logs.join("\n")
      expect(output).toContain("write_todos")
      expect(output).toContain("hint:")
    })
  })

  it("does not show native tool hint outside an agent", async () => {
    await serial(async () => {
      const home = join(TMP, "issue-290-hint-noagent")
      const repoCwdRaw = join(TMP, "issue-290-repo-noagent")
      const currentSession = "22222222-3333-4444-5555-aaaaaaaaaaaa"
      const prevSession = "22222222-3333-4444-5555-bbbbbbbbbbbb"

      await mkdir(repoCwdRaw, { recursive: true })

      // chdir first to get the canonical cwd (macOS resolves /var → /private/var)
      const prevCwd = process.cwd()
      process.chdir(repoCwdRaw)
      const repoCwd = process.cwd()

      const projKey = projectKeyFromCwd(repoCwd)
      await mkdir(join(home, ".claude", "projects", projKey), { recursive: true })
      await writeFile(
        join(home, ".claude", "projects", projKey, `${currentSession}.jsonl`),
        `${JSON.stringify({ type: "user", cwd: repoCwd })}\n`
      )
      await writeFile(
        join(home, ".claude", "projects", projKey, `${prevSession}.jsonl`),
        `${JSON.stringify({ type: "user", cwd: repoCwd })}\n`
      )

      // Previous session: has incomplete task (older mtime)
      await mkdir(join(home, ".claude", "tasks", prevSession), { recursive: true })
      await writeFile(
        join(home, ".claude", "tasks", prevSession, "1.json"),
        JSON.stringify({
          id: "1",
          subject: "Incomplete task",
          description: "",
          status: "in_progress",
          blocks: [],
          blockedBy: [],
        })
      )
      const oldTime = new Date(Date.now() - 60_000)
      await utimes(join(home, ".claude", "tasks", prevSession), oldTime, oldTime)

      // Current session: all tasks completed (newer mtime)
      await mkdir(join(home, ".claude", "tasks", currentSession), { recursive: true })
      await writeFile(
        join(home, ".claude", "tasks", currentSession, "1.json"),
        JSON.stringify({
          id: "1",
          subject: "Done task",
          description: "",
          status: "completed",
          blocks: [],
          blockedBy: [],
        })
      )

      const prevHome = process.env.HOME
      // Clear all agent env vars
      const prevClaudeCode = process.env.CLAUDECODE
      const prevGemini = process.env.GEMINI_CLI
      const prevGeminiDir = process.env.GEMINI_PROJECT_DIR
      const prevCursorTrace = process.env.CURSOR_TRACE_ID
      const prevCodexManaged = process.env.CODEX_MANAGED_BY_NPM
      const prevCodexThread = process.env.CODEX_THREAD_ID
      delete process.env.CLAUDECODE
      delete process.env.GEMINI_CLI
      delete process.env.GEMINI_PROJECT_DIR
      delete process.env.CURSOR_TRACE_ID
      delete process.env.CODEX_MANAGED_BY_NPM
      delete process.env.CODEX_THREAD_ID
      process.env.HOME = home

      const logs: string[] = []
      const origLog = console.log
      console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "))

      try {
        await tasksCommand.run([])
      } finally {
        console.log = origLog
        process.chdir(prevCwd)
        if (prevHome === undefined) delete process.env.HOME
        else process.env.HOME = prevHome
        if (prevClaudeCode === undefined) delete process.env.CLAUDECODE
        else process.env.CLAUDECODE = prevClaudeCode
        if (prevGemini === undefined) delete process.env.GEMINI_CLI
        else process.env.GEMINI_CLI = prevGemini
        if (prevGeminiDir === undefined) delete process.env.GEMINI_PROJECT_DIR
        else process.env.GEMINI_PROJECT_DIR = prevGeminiDir
        if (prevCursorTrace === undefined) delete process.env.CURSOR_TRACE_ID
        else process.env.CURSOR_TRACE_ID = prevCursorTrace
        if (prevCodexManaged === undefined) delete process.env.CODEX_MANAGED_BY_NPM
        else process.env.CODEX_MANAGED_BY_NPM = prevCodexManaged
        if (prevCodexThread === undefined) delete process.env.CODEX_THREAD_ID
        else process.env.CODEX_THREAD_ID = prevCodexThread
      }

      const output = logs.join("\n")
      // Should still show the incomplete hint but NOT the native tool hint
      expect(output).toContain("Incomplete tasks")
      expect(output).not.toContain("hint:")
    })
  })
})

describe("task transition validator (#302)", () => {
  const { validateTransition } = require("../../src/tasks/task-service.ts") as {
    validateTransition: (old: string, next: string) => string | null
  }

  it("allows pending → in_progress", () => {
    expect(validateTransition("pending", "in_progress")).toBeNull()
  })

  it("allows in_progress → completed", () => {
    expect(validateTransition("in_progress", "completed")).toBeNull()
  })

  it("rejects pending → completed", () => {
    const error = validateTransition("pending", "completed")
    expect(error).not.toBeNull()
    expect(error).toContain("in_progress")
  })

  it("allows completed → in_progress (reopen)", () => {
    expect(validateTransition("completed", "in_progress")).toBeNull()
  })

  it("allows pending → cancelled", () => {
    expect(validateTransition("pending", "cancelled")).toBeNull()
  })

  it("allows same-status no-op", () => {
    expect(validateTransition("pending", "pending")).toBeNull()
    expect(validateTransition("in_progress", "in_progress")).toBeNull()
  })
})
