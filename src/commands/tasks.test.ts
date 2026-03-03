import { mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { projectKeyFromCwd } from "../transcript-utils.ts"
import { getSessionIdsByCwdScan, getSessionIdsForProject, getSessions } from "./tasks.ts"

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
    await writeFile(join(TASKS, s, "1.json"), JSON.stringify({ id: "1", status: "completed" }))
  }

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
