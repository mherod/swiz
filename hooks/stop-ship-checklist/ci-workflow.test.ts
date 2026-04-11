/**
 * Unit tests for hooks/stop-ship-checklist/ci-workflow.ts.
 *
 * Pins the polling budget required by issue #509:
 *   AC1: Maximum CI poll time is ≤ 15000 ms (enforced by MAX_POLL_MS constant
 *        AND by a virtual-clock test that asserts the loop exits at or before
 *        the budget)
 *   AC2: Hook still correctly reports failing/active/passing CI state — the
 *        loop returns the latest fetched runs and exits the moment none are
 *        active
 *   AC3: Total hook budget has headroom — the loop is bounded by
 *        ⌈MAX_POLL_MS / POLL_INTERVAL_MS⌉ sleep iterations, leaving the
 *        remainder of the 65s hook timeout for git + issues work
 *   AC4: No behavior change for the no-CI-runs fast path — zero sleeps, one
 *        fetch, early return
 */
import { describe, expect, test } from "bun:test"
import {
  type CIRun,
  MAX_POLL_MS,
  POLL_INTERVAL_MS,
  type PollDeps,
  pollUntilComplete,
} from "./ci-workflow.ts"

// ─── CIRun fixtures ─────────────────────────────────────────────────────────

function makeRun(overrides: Partial<CIRun> = {}): CIRun {
  return {
    databaseId: 1,
    status: "in_progress",
    conclusion: "",
    workflowName: "CI",
    createdAt: "2026-04-11T10:00:00Z",
    event: "push",
    ...overrides,
  }
}

// ─── Virtual-clock deps factory ─────────────────────────────────────────────

interface FakeClock {
  deps: PollDeps
  sleepCount: number
  sleepTotalMs: number
  fetchCount: number
  elapsedMs: number
}

/**
 * Build a PollDeps bundle that advances a virtual clock deterministically.
 * `runSequence[i]` is the list of runs returned on the i-th fetch; if the
 * fetch count exceeds the sequence length the last entry is returned.
 */
function makeFakeDeps(runSequence: CIRun[][]): FakeClock {
  const state: FakeClock = {
    deps: {
      fetcher: (_branch: string, _cwd: string): Promise<CIRun[]> => {
        state.fetchCount++
        const idx = Math.min(state.fetchCount - 1, runSequence.length - 1)
        return Promise.resolve(runSequence[idx] ?? [])
      },
      sleep: (ms: number) => {
        state.sleepCount++
        state.sleepTotalMs += ms
        state.elapsedMs += ms
        return Promise.resolve()
      },
      now: () => state.elapsedMs,
    },
    sleepCount: 0,
    sleepTotalMs: 0,
    fetchCount: 0,
    elapsedMs: 0,
  }
  return state
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("CI poll budget (issue #509)", () => {
  test("AC1: MAX_POLL_MS is capped at 15000", () => {
    expect(MAX_POLL_MS).toBeLessThanOrEqual(15_000)
  })

  test("AC1: POLL_INTERVAL_MS divides MAX_POLL_MS into at least 2 iterations", () => {
    // A single iteration means one sleep consumes the entire budget —
    // i.e. the loop degenerates into "sleep then fetch once". The issue's
    // complaint was exactly this shape. Require strictly more than one
    // iteration to guard against regressing to POLL_INTERVAL_MS = MAX_POLL_MS.
    expect(POLL_INTERVAL_MS).toBeLessThan(MAX_POLL_MS)
    const maxIterations = Math.floor(MAX_POLL_MS / POLL_INTERVAL_MS)
    expect(maxIterations).toBeGreaterThanOrEqual(2)
  })

  test("AC1: wall-clock budget does not exceed MAX_POLL_MS even when CI never completes", async () => {
    // Fetcher always returns the same active run — loop never finds a
    // completion signal, so the deadline is the only exit condition.
    const fake = makeFakeDeps([[makeRun({ status: "in_progress" })]])
    await pollUntilComplete("feat/x", "/repo", fake.deps)
    expect(fake.sleepTotalMs).toBeLessThanOrEqual(MAX_POLL_MS)
  })

  test("AC1/AC3: iteration count is bounded by ⌈MAX_POLL_MS/POLL_INTERVAL_MS⌉", async () => {
    const fake = makeFakeDeps([[makeRun({ status: "in_progress" })]])
    await pollUntilComplete("feat/x", "/repo", fake.deps)
    const maxIterations = Math.ceil(MAX_POLL_MS / POLL_INTERVAL_MS)
    expect(fake.sleepCount).toBeLessThanOrEqual(maxIterations)
    // Fetcher is called once at the top of the loop plus once per sleep.
    expect(fake.fetchCount).toBeLessThanOrEqual(maxIterations + 1)
  })

  test("AC2: returns active runs unchanged when deadline elapses with work still active", async () => {
    const activeRun = makeRun({ status: "in_progress", workflowName: "CI" })
    const fake = makeFakeDeps([[activeRun]])
    const result = await pollUntilComplete("feat/x", "/repo", fake.deps)
    expect(result.length).toBe(1)
    expect(result[0]!.status).toBe("in_progress")
  })

  test("AC2: exits early as soon as all runs complete", async () => {
    const inProgress = makeRun({ status: "in_progress" })
    const completed = makeRun({ status: "completed", conclusion: "success" })
    // First fetch: active. Second fetch: completed. Loop should exit after
    // one sleep + one additional fetch.
    const fake = makeFakeDeps([[inProgress], [completed]])
    const result = await pollUntilComplete("feat/x", "/repo", fake.deps)
    expect(result.length).toBe(1)
    expect(result[0]!.status).toBe("completed")
    expect(fake.sleepCount).toBe(1)
    expect(fake.fetchCount).toBe(2)
  })

  test("AC2: surfaces failing runs without additional polling", async () => {
    // The loop only polls while runs are active. A completed+failed run
    // on the first fetch exits immediately — the caller (collectCiWorkflow)
    // then classifies via findFailing.
    const failed = makeRun({ status: "completed", conclusion: "failure" })
    const fake = makeFakeDeps([[failed]])
    const result = await pollUntilComplete("feat/x", "/repo", fake.deps)
    expect(result.length).toBe(1)
    expect(result[0]!.conclusion).toBe("failure")
    expect(fake.sleepCount).toBe(0)
    expect(fake.fetchCount).toBe(1)
  })

  test("AC4: no-CI-runs fast path makes exactly 1 fetch and 0 sleeps", async () => {
    const fake = makeFakeDeps([[]])
    const result = await pollUntilComplete("feat/x", "/repo", fake.deps)
    expect(result).toEqual([])
    expect(fake.fetchCount).toBe(1)
    expect(fake.sleepCount).toBe(0)
    expect(fake.elapsedMs).toBe(0)
  })

  test("AC3: total poll wall-clock leaves 50+ seconds of headroom in the 65s hook budget", async () => {
    const fake = makeFakeDeps([[makeRun({ status: "in_progress" })]])
    await pollUntilComplete("feat/x", "/repo", fake.deps)
    const HOOK_TIMEOUT_MS = 65_000
    const headroom = HOOK_TIMEOUT_MS - fake.sleepTotalMs
    expect(headroom).toBeGreaterThanOrEqual(50_000)
  })
})
