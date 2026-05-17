import { describe, expect, test } from "bun:test"
import {
  isTaskSubjectCarryoverDeferral,
  isTaskSubjectWorkDeferral,
  stripTaskSubjectCarryoverDeferralPrefix,
} from "./task-subject-deferral.ts"

describe("isTaskSubjectWorkDeferral", () => {
  test("matches subjects that defer work to a later session", () => {
    expect(isTaskSubjectWorkDeferral("Defer #1727")).toBe(true)
    expect(isTaskSubjectWorkDeferral("Move issue #52 to next session")).toBe(true)
    expect(isTaskSubjectWorkDeferral("Next session: resolve issue #52")).toBe(true)
    expect(isTaskSubjectWorkDeferral("Follow-up: pick up #641 at next session start")).toBe(true)
    expect(isTaskSubjectWorkDeferral("Future : refactor billing module")).toBe(true)
  })

  test("does not match legitimate current-session work", () => {
    expect(isTaskSubjectWorkDeferral("Implement deferred image loading")).toBe(false)
    expect(isTaskSubjectWorkDeferral("Follow-up: docs for new flag")).toBe(false)
    expect(isTaskSubjectWorkDeferral("Add session token refresh logic")).toBe(false)
  })
})

describe("isTaskSubjectCarryoverDeferral", () => {
  test("matches stop-check carry-over note prefixes", () => {
    expect(isTaskSubjectCarryoverDeferral("Consider extracting helper")).toBe(true)
    expect(isTaskSubjectCarryoverDeferral("Future: revisit cache TTL")).toBe(true)
    expect(isTaskSubjectCarryoverDeferral("Follow-up: docs for new flag")).toBe(true)
    expect(isTaskSubjectCarryoverDeferral("Follow up: docs for new flag")).toBe(true)
  })

  test("does not match arbitrary next-session phrasing", () => {
    expect(isTaskSubjectCarryoverDeferral("Move issue #52 to next session")).toBe(false)
    expect(isTaskSubjectCarryoverDeferral("Wire up the migration")).toBe(false)
  })
})

describe("stripTaskSubjectCarryoverDeferralPrefix", () => {
  test("removes only the carry-over prefix", () => {
    expect(stripTaskSubjectCarryoverDeferralPrefix("Follow-up: docs for new flag")).toBe(
      "docs for new flag"
    )
    expect(stripTaskSubjectCarryoverDeferralPrefix("Consider extracting helper")).toBe(
      "extracting helper"
    )
  })
})
