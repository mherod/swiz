import { mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { projectKeyFromCwd } from "../transcript-utils.ts"
import {
  findTaskAcrossSessions,
  getSessionIdsByCwdScan,
  getSessionIdsForProject,
  getSessions,
  resolveTaskById,
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

  // ── Project directory matching the canonical key ──
  // This directory holds transcripts for SESSION_A only (fast-path match).
  const canonicalKey = projectKeyFromCwd(FILTER_CWD)
  const canonicalDir = join(PROJECTS, canonicalKey)
  await mkdir(canonicalDir, { recursive: true })
  await writeFile(
    join(canonicalDir, `${SESSION_A}.jsonl`),
    JSON.stringify({ type: "user", cwd: FILTER_CWD }) + "\n"
  )

  // ── Alternate project directory (different encoding) ──
  // Simulates an older encoding that doesn't match projectKeyFromCwd().
  // Holds transcripts for SESSION_B and SESSION_C.
  const altDir = join(PROJECTS, "alt-legacy-encoding")
  await mkdir(altDir, { recursive: true })
  await writeFile(
    join(altDir, `${SESSION_B}.jsonl`),
    JSON.stringify({ type: "user", cwd: FILTER_CWD }) + "\n"
  )
  await writeFile(
    join(altDir, `${SESSION_C}.jsonl`),
    JSON.stringify({ type: "user", cwd: FILTER_CWD }) + "\n"
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
      JSON.stringify({ type: "user", cwd: FILTER_CWD }) + "\n"
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
  it("accepts valid evidence prefixes", () => {
    expect(validateEvidence("commit:abc123f")).toBeNull()
    expect(validateEvidence("pr:42")).toBeNull()
    expect(validateEvidence("file:src/feature.ts")).toBeNull()
    expect(validateEvidence("test:all-passed")).toBeNull()
    expect(validateEvidence("note:CI green — conclusion: success")).toBeNull()
  })

  it("rejects evidence without a recognized prefix", () => {
    const error = validateEvidence("just some text")
    expect(error).not.toBeNull()
    expect(error).toContain("Invalid evidence format")
    expect(error).toContain("commit:")
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
    const result = await findTaskAcrossSessions("120", undefined, TASKS, PROJECTS)
    expect(result).not.toBeNull()
    expect(result!.sessionId).toBe(SESSION_B)
    expect(result!.task.id).toBe("120")
    expect(result!.task.subject).toBe("Push and verify CI")
  })

  it("finds a task in the primary session first", async () => {
    // Task #1 exists in all sessions — should find it in the first one returned
    const result = await findTaskAcrossSessions("1", undefined, TASKS, PROJECTS)
    expect(result).not.toBeNull()
    expect(result!.task.id).toBe("1")
  })

  it("returns null for a nonexistent task ID", async () => {
    const result = await findTaskAcrossSessions("999", undefined, TASKS, PROJECTS)
    expect(result).toBeNull()
  })

  it("scopes search to project sessions when filterCwd is provided", async () => {
    // Create an isolated setup where only SESSION_A matches the CWD
    const isolatedProjects = join(TMP, "projects-isolated-cross")
    const key = projectKeyFromCwd(FILTER_CWD)
    await mkdir(join(isolatedProjects, key), { recursive: true })
    await writeFile(
      join(isolatedProjects, key, `${SESSION_A}.jsonl`),
      JSON.stringify({ type: "user", cwd: FILTER_CWD }) + "\n"
    )

    // Task #120 is in SESSION_B which is NOT in this isolated project dir
    const result = await findTaskAcrossSessions("120", FILTER_CWD, TASKS, isolatedProjects)
    // SESSION_B isn't matched by filterCwd in the isolated setup, so fallback scan runs
    // But the alt-legacy-encoding dir doesn't exist in isolatedProjects
    expect(result).toBeNull()
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

  it("prefers primary session over fallback for same task ID", async () => {
    // Task #1 exists in all sessions — primary should win
    const result = await resolveTaskById("1", SESSION_C, undefined, TASKS, PROJECTS)
    expect(result.sessionId).toBe(SESSION_C)
  })
})
