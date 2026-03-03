import { describe, expect, test } from "bun:test"
import { findActive, findFailing } from "./stop-github-ci.ts"

const base = {
  databaseId: 1,
  displayTitle: "CI",
  createdAt: "2026-01-01T00:00:00Z",
  event: "push",
}

describe("findActive", () => {
  test("returns in_progress runs", () => {
    const runs = [{ ...base, workflowName: "CI", status: "in_progress", conclusion: "" }]
    expect(findActive(runs)).toHaveLength(1)
  })

  test("returns queued runs", () => {
    const runs = [{ ...base, workflowName: "CI", status: "queued", conclusion: "" }]
    expect(findActive(runs)).toHaveLength(1)
  })

  test("excludes completed runs", () => {
    const runs = [{ ...base, workflowName: "CI", status: "completed", conclusion: "success" }]
    expect(findActive(runs)).toHaveLength(0)
  })

  test("returns empty array for empty input", () => {
    expect(findActive([])).toHaveLength(0)
  })
})

describe("findFailing", () => {
  test("returns failure runs", () => {
    const runs = [{ ...base, workflowName: "CI", status: "completed", conclusion: "failure" }]
    expect(findFailing(runs)).toHaveLength(1)
  })

  test("returns timed_out runs", () => {
    const runs = [{ ...base, workflowName: "CI", status: "completed", conclusion: "timed_out" }]
    expect(findFailing(runs)).toHaveLength(1)
  })

  test("returns action_required runs", () => {
    const runs = [
      { ...base, workflowName: "CI", status: "completed", conclusion: "action_required" },
    ]
    expect(findFailing(runs)).toHaveLength(1)
  })

  test("excludes success runs", () => {
    const runs = [{ ...base, workflowName: "CI", status: "completed", conclusion: "success" }]
    expect(findFailing(runs)).toHaveLength(0)
  })

  test("excludes in_progress runs", () => {
    const runs = [{ ...base, workflowName: "CI", status: "in_progress", conclusion: "" }]
    expect(findFailing(runs)).toHaveLength(0)
  })

  test("takes most recent run per workflow when multiple exist", () => {
    const runs = [
      {
        ...base,
        workflowName: "CI",
        status: "completed",
        conclusion: "failure",
        createdAt: "2026-01-01T00:00:00Z",
      },
      {
        ...base,
        databaseId: 2,
        workflowName: "CI",
        status: "completed",
        conclusion: "success",
        createdAt: "2026-01-02T00:00:00Z",
      },
    ]
    // Most recent is success — should not be in failing
    expect(findFailing(runs)).toHaveLength(0)
  })

  test("keeps failure when it is the most recent of its workflow", () => {
    const runs = [
      {
        ...base,
        workflowName: "CI",
        status: "completed",
        conclusion: "success",
        createdAt: "2026-01-01T00:00:00Z",
      },
      {
        ...base,
        databaseId: 2,
        workflowName: "CI",
        status: "completed",
        conclusion: "failure",
        createdAt: "2026-01-02T00:00:00Z",
      },
    ]
    expect(findFailing(runs)).toHaveLength(1)
  })

  test("handles multiple distinct workflows independently", () => {
    const runs = [
      { ...base, workflowName: "Lint", status: "completed", conclusion: "failure" },
      { ...base, databaseId: 2, workflowName: "Test", status: "completed", conclusion: "success" },
    ]
    const failing = findFailing(runs)
    expect(failing).toHaveLength(1)
    expect(failing[0]?.workflowName).toBe("Lint")
  })

  test("returns empty array for empty input", () => {
    expect(findFailing([])).toHaveLength(0)
  })
})
