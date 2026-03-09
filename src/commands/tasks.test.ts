import { mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
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
  validateEvidence,
  verifyTaskSubject,
} from "./tasks.ts"

const TMP = join(tmpdir(), `swiz-tasks-test-${process.pid}-${Date.now()}`)
const TASKS = join(TMP, "tasks")
const PROJECTS = join(TMP, "projects")
const FILTER_CWD = "/Users/test/Development/myproject"

// Session IDs
const SESSION_A = "aaaa-aaaa-aaaa"
const SESSION_B = "bbbb-bbbb-bbbb"
const SESSION_C = "cccc-cccc-cccc"

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
})

// ─── validateEvidence ─────────────────────────────────────────────────────────

describe("validateEvidence", () => {
  it("accepts evidence with 1+ structured fields", () => {
    expect(validateEvidence("note:CI green — conclusion: success")).toBeNull()
    expect(validateEvidence("commit:abc123f — note:tests passed")).toBeNull()
    expect(validateEvidence("note:all checks passed — conclusion: done")).toBeNull()
    expect(validateEvidence("note:bulk-complete — conclusion: all tasks completed")).toBeNull()
    // single-field evidence is now valid
    expect(validateEvidence("note:only one structured field present")).toBeNull()
    expect(validateEvidence("note:CI green only one field here")).toBeNull()
  })

  it("rejects evidence without a recognized prefix", () => {
    const error = validateEvidence("just some text")
    expect(error).not.toBeNull()
    expect(error).toContain("Invalid evidence format")
    expect(error).toContain("commit:")
  })

  it("rejects evidence with 0 structured fields (valid prefix but too short value)", () => {
    // "note:hi" passes prefix check but the note regex requires 5+ chars after note:
    const error = validateEvidence("note:hi")
    expect(error).not.toBeNull()
    expect(error).toContain("at least 1 structured field")
    expect(error).toContain("found 0")
  })

  it("does not count embedded text in a field's value as a separate field", () => {
    // "CI green" appears inside the note value — must NOT be counted as a separate ci_green field;
    // but with REQUIRED=1 the overall call is valid
    expect(validateEvidence("note:CI green only one field here")).toBeNull()
  })

  it("rejects empty-ish evidence without prefix", () => {
    expect(validateEvidence("CI passed")).not.toBeNull()
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
    // Create an isolated setup where only SESSION_A matches the CWD
    const isolatedProjects = join(TMP, "projects-isolated-cross")
    const key = projectKeyFromCwd(FILTER_CWD)
    await mkdir(join(isolatedProjects, key), { recursive: true })
    await writeFile(
      join(isolatedProjects, key, `${SESSION_A}.jsonl`),
      `${JSON.stringify({ type: "user", cwd: FILTER_CWD })}\n`
    )

    // Task #120 is in SESSION_B which is NOT in this isolated project dir
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
