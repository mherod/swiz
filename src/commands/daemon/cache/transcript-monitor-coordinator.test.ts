import { describe, expect, test } from "bun:test"
import {
  createDeferred,
  type Deferred,
  TranscriptMonitorCoordinator,
} from "./transcript-monitor-coordinator.ts"

describe("TranscriptMonitorCoordinator", () => {
  test("coalesces concurrent triggers for the same project to at most one active check and one trailing rerun", async () => {
    let activeChecks = 0
    let maxConcurrentObserved = 0
    let totalExecutions = 0
    const inFlightResolvers: Deferred<{ durationMs: number }>[] = []

    const coordinator = new TranscriptMonitorCoordinator({
      maxConcurrentChecks: 4,
      executeCheck: async () => {
        activeChecks++
        maxConcurrentObserved = Math.max(maxConcurrentObserved, activeChecks)
        totalExecutions++
        const d = createDeferred<{ durationMs: number }>()
        inFlightResolvers.push(d)
        const res = await d.promise
        activeChecks--
        return res
      },
    })

    // Trigger 1: starts immediately
    const p1 = coordinator.checkProject("/project-a")
    expect(totalExecutions).toBe(1)
    expect(activeChecks).toBe(1)

    // Trigger 2: arrives while Trigger 1 is running -> schedules trailing rerun
    const p2 = coordinator.checkProject("/project-a")
    // Trigger 3: arrives while Trigger 1 is still running and trailing rerun is scheduled -> coalesced
    const p3 = coordinator.checkProject("/project-a")
    // Trigger 4: arrives while Trigger 1 is still running -> coalesced
    const p4 = coordinator.checkProject("/project-a")

    expect(totalExecutions).toBe(1) // Still only 1 execution started
    expect(coordinator.getMetrics().coalescedTriggers).toBe(2) // Triggers 3 and 4 were coalesced

    // Complete Trigger 1
    inFlightResolvers[0]!.resolve({ durationMs: 42 })
    await p1

    // Trailing rerun should have started
    expect(totalExecutions).toBe(2)
    expect(activeChecks).toBe(1)

    // Complete trailing rerun
    inFlightResolvers[1]!.resolve({ durationMs: 15 })
    await Promise.all([p2, p3, p4])

    expect(maxConcurrentObserved).toBe(1)
    expect(totalExecutions).toBe(2)
    expect(activeChecks).toBe(0)
    expect(coordinator.getMetrics().activeChecks).toBe(0)
    expect(coordinator.getMetrics().queuedChecks).toBe(0)
  })

  test("coalesces triggers received while a project is waiting in queue", async () => {
    let totalExecutions = 0
    const inFlightResolvers: Deferred<{ durationMs: number }>[] = []

    const coordinator = new TranscriptMonitorCoordinator({
      maxConcurrentChecks: 1,
      executeCheck: async () => {
        totalExecutions++
        const d = createDeferred<{ durationMs: number }>()
        inFlightResolvers.push(d)
        return d.promise
      },
    })

    // Project A fills the single concurrency slot
    const pA = coordinator.checkProject("/project-a")
    expect(totalExecutions).toBe(1)

    // Project B is queued
    const pB1 = coordinator.checkProject("/project-b")
    expect(coordinator.getMetrics().queuedChecks).toBe(1)

    // Additional triggers for Project B while queued should coalesce
    const pB2 = coordinator.checkProject("/project-b")
    const pB3 = coordinator.checkProject("/project-b")
    expect(coordinator.getMetrics().coalescedTriggers).toBe(2)
    expect(coordinator.getMetrics().queuedChecks).toBe(1)

    // Finish A
    inFlightResolvers[0]!.resolve({ durationMs: 10 })
    await pA

    // B should now be running
    expect(totalExecutions).toBe(2)
    inFlightResolvers[1]!.resolve({ durationMs: 12 })
    await Promise.all([pB1, pB2, pB3])

    expect(totalExecutions).toBe(2)
    expect(coordinator.getMetrics().coalescedTriggers).toBe(2)
  })

  test("guarantees fair progress across different projects without starvation", async () => {
    const executionOrder: string[] = []
    const inFlightResolvers: Deferred<{ durationMs: number }>[] = []

    const coordinator = new TranscriptMonitorCoordinator({
      maxConcurrentChecks: 1,
      executeCheck: async (cwd) => {
        executionOrder.push(cwd)
        const d = createDeferred<{ durationMs: number }>()
        inFlightResolvers.push(d)
        return d.promise
      },
    })

    // Start A (active), queue B, queue C
    const pA1 = coordinator.checkProject("/project-a")
    const pB = coordinator.checkProject("/project-b")
    const pC = coordinator.checkProject("/project-c")

    // While A is running, trigger A again (schedules trailing rerun)
    const pA2 = coordinator.checkProject("/project-a")

    expect(executionOrder).toEqual(["/project-a"])

    // Complete A1
    inFlightResolvers[0]!.resolve({ durationMs: 10 })
    await pA1

    // B was queued before A's trailing rerun, so B MUST run next (fair FIFO)
    expect(executionOrder).toEqual(["/project-a", "/project-b"])

    // Complete B
    inFlightResolvers[1]!.resolve({ durationMs: 10 })
    await pB

    // C was queued before A's trailing rerun, so C MUST run next
    expect(executionOrder).toEqual(["/project-a", "/project-b", "/project-c"])

    // Complete C
    inFlightResolvers[2]!.resolve({ durationMs: 10 })
    await pC

    // Now A's trailing rerun runs
    expect(executionOrder).toEqual(["/project-a", "/project-b", "/project-c", "/project-a"])

    // Complete A2
    inFlightResolvers[3]!.resolve({ durationMs: 10 })
    await pA2
  })

  test("enforces bounded queue depth and rejects excess project checks", async () => {
    const inFlightResolvers: Deferred<{ durationMs: number }>[] = []

    const coordinator = new TranscriptMonitorCoordinator({
      maxConcurrentChecks: 1,
      maxQueueDepth: 2,
      executeCheck: async () => {
        const d = createDeferred<{ durationMs: number }>()
        inFlightResolvers.push(d)
        return d.promise
      },
    })

    const p1 = coordinator.checkProject("/p1") // active (1)
    const p2 = coordinator.checkProject("/p2") // queued (1)
    const p3 = coordinator.checkProject("/p3") // queued (2)

    expect(coordinator.getMetrics().activeChecks).toBe(1)
    expect(coordinator.getMetrics().queuedChecks).toBe(2)

    // Exceeds maxQueueDepth = 2
    await expect(coordinator.checkProject("/p4")).rejects.toThrow("queue depth exceeded")

    // Existing checks are not corrupted and complete normally
    inFlightResolvers[0]!.resolve({ durationMs: 5 })
    await p1
    inFlightResolvers[1]!.resolve({ durationMs: 5 })
    await p2
    inFlightResolvers[2]!.resolve({ durationMs: 5 })
    await p3

    expect(coordinator.getMetrics().activeChecks).toBe(0)
    expect(coordinator.getMetrics().queuedChecks).toBe(0)
  })

  test("acknowledges completions with truthful duration and outcome callbacks", async () => {
    const completedRecords: Array<{ cwd: string; durationMs: number; outcome: string }> = []

    const coordinator = new TranscriptMonitorCoordinator({
      maxConcurrentChecks: 2,
      executeCheck: async (cwd) => {
        if (cwd === "/error-project") {
          return { durationMs: 25, error: "Disk read failed" }
        }
        return { durationMs: 50 }
      },
      onCheckCompleted: (cwd, durationMs, outcome) => {
        completedRecords.push({ cwd, durationMs, outcome })
      },
    })

    await coordinator.checkProject("/good-project")
    await expect(coordinator.checkProject("/error-project")).rejects.toThrow("Disk read failed")

    expect(completedRecords).toEqual([
      { cwd: "/good-project", durationMs: 50, outcome: "success" },
      { cwd: "/error-project", durationMs: 25, outcome: "error" },
    ])
  })

  test("records no telemetry sample for checks the worker skipped", async () => {
    const completedRecords: Array<{ cwd: string; durationMs: number; outcome: string }> = []

    const coordinator = new TranscriptMonitorCoordinator({
      maxConcurrentChecks: 2,
      executeCheck: async (cwd) => {
        if (cwd === "/degraded-project") {
          return { durationMs: 0, skipped: true }
        }
        return { durationMs: 50 }
      },
      onCheckCompleted: (cwd, durationMs, outcome) => {
        completedRecords.push({ cwd, durationMs, outcome })
      },
    })

    // Control: a real check still records, proving the callback is wired up.
    await coordinator.checkProject("/good-project")
    // A skipped check resolves normally but contributes no 0ms sample.
    await coordinator.checkProject("/degraded-project")

    expect(completedRecords).toEqual([{ cwd: "/good-project", durationMs: 50, outcome: "success" }])
  })

  test("recovers from worker errors and continues draining the queue", async () => {
    let callCount = 0
    const recordedDurations: number[] = []
    const coordinator = new TranscriptMonitorCoordinator({
      maxConcurrentChecks: 1,
      onCheckCompleted: (_cwd, durationMs) => recordedDurations.push(durationMs),
      executeCheck: async (cwd) => {
        callCount++
        if (cwd === "/failing-project") {
          throw new Error("Worker crash")
        }
        return { durationMs: 10 }
      },
    })

    const pFail = coordinator.checkProject("/failing-project")
    const pSuccess = coordinator.checkProject("/success-project")

    await expect(pFail).rejects.toThrow("Worker crash")
    await expect(pSuccess).resolves.toBeUndefined()
    expect(callCount).toBe(2)
    expect(coordinator.getMetrics().activeChecks).toBe(0)
    expect(recordedDurations).toEqual([10])
  })

  test("rejects new and in-flight checks on coordinator close", async () => {
    let unblock = () => {}
    const coordinator = new TranscriptMonitorCoordinator({
      maxConcurrentChecks: 1,
      executeCheck: () =>
        new Promise((resolve) => {
          unblock = () => resolve({ durationMs: 0 })
        }),
    })

    const p1 = coordinator.checkProject("/p1").catch((err: Error) => err)
    const p2 = coordinator.checkProject("/p2").catch((err: Error) => err)

    coordinator.close("Shutting down daemon")
    unblock()

    const [err1, err2] = await Promise.all([p1, p2])
    expect(err1).toBeInstanceOf(Error)
    expect(err2).toBeInstanceOf(Error)
    expect((err1 as Error).message).toBe("Shutting down daemon")
    expect((err2 as Error).message).toBe("Shutting down daemon")
    expect(coordinator.getMetrics().activeChecks).toBe(0)
    expect(coordinator.getMetrics().queuedChecks).toBe(0)

    // New requests reject immediately
    await expect(coordinator.checkProject("/p3")).rejects.toThrow("coordinator is closed")
  })
})
