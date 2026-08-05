import { describe, expect, test } from "bun:test"
import { parseToolResponse } from "./task-list-reconciliation.ts"

describe("parseToolResponse", () => {
  test("recognizes an authoritative empty task list", () => {
    expect(parseToolResponse({ tasks: [] })).toEqual({
      kind: "recognized",
      tasks: [],
    })
  })

  test("distinguishes missing input from an unsupported non-empty shape", () => {
    expect(parseToolResponse(null)).toEqual({
      kind: "unrecognized",
      hasContent: false,
      reason: "missing-response",
    })
    expect(parseToolResponse({ results: [] })).toEqual({
      kind: "unrecognized",
      hasContent: true,
      reason: "unsupported-shape",
    })
  })

  test("rejects a non-empty tasks array containing malformed tasks", () => {
    expect(parseToolResponse({ tasks: [{ id: "1", status: "pending" }] })).toEqual({
      kind: "unrecognized",
      hasContent: true,
      reason: "malformed-task",
    })
  })
})
