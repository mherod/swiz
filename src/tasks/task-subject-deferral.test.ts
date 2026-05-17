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

  test("matches park/shelve/icebox leading words", () => {
    expect(isTaskSubjectWorkDeferral("Park this issue")).toBe(true)
    expect(isTaskSubjectWorkDeferral("Parked: billing refactor")).toBe(true)
    expect(isTaskSubjectWorkDeferral("Parking this for now")).toBe(true)
    expect(isTaskSubjectWorkDeferral("Shelve the auth migration")).toBe(true)
    expect(isTaskSubjectWorkDeferral("Shelved: billing work")).toBe(true)
    expect(isTaskSubjectWorkDeferral("Icebox: redesign the UI")).toBe(true)
    expect(isTaskSubjectWorkDeferral("Iceboxed: dark mode implementation")).toBe(true)
  })

  test("matches carry-over and carry-forward", () => {
    expect(isTaskSubjectWorkDeferral("Carry over the billing migration")).toBe(true)
    expect(isTaskSubjectWorkDeferral("Carry-over: auth refactor")).toBe(true)
    expect(isTaskSubjectWorkDeferral("Carry forward the database changes")).toBe(true)
    expect(isTaskSubjectWorkDeferral("Carryforward: UI work")).toBe(true)
  })

  test("matches to/for/until next sprint or release", () => {
    expect(isTaskSubjectWorkDeferral("Save this fix for next sprint")).toBe(true)
    expect(isTaskSubjectWorkDeferral("Hold until next release")).toBe(true)
    expect(isTaskSubjectWorkDeferral("Push to next iteration")).toBe(true)
    expect(isTaskSubjectWorkDeferral("Next sprint: fix auth bug")).toBe(true)
    expect(isTaskSubjectWorkDeferral("Next release: bump deps")).toBe(true)
  })

  test("matches follow-up with vague intent words", () => {
    expect(isTaskSubjectWorkDeferral("Follow-up: consider issue #633")).toBe(true)
    expect(isTaskSubjectWorkDeferral("Follow-up: revisit cache TTL strategy")).toBe(true)
  })

  test("matches someday/eventually/hold leading words", () => {
    expect(isTaskSubjectWorkDeferral("Someday: migrate to new framework")).toBe(true)
    expect(isTaskSubjectWorkDeferral("Eventually: add dark mode")).toBe(true)
    expect(isTaskSubjectWorkDeferral("Hold: auth refactor")).toBe(true)
    expect(isTaskSubjectWorkDeferral("Hold off: billing changes")).toBe(true)
  })

  test("does not match legitimate current-session work", () => {
    expect(isTaskSubjectWorkDeferral("Implement deferred image loading")).toBe(false)
    expect(isTaskSubjectWorkDeferral("Follow-up: docs for new flag")).toBe(false)
    expect(isTaskSubjectWorkDeferral("Add session token refresh logic")).toBe(false)
    expect(isTaskSubjectWorkDeferral("Follow-up: implement the verified fix")).toBe(false)
    expect(isTaskSubjectWorkDeferral("Refactor carry-over validation logic")).toBe(false)
  })
})

describe("isTaskSubjectCarryoverDeferral", () => {
  test("matches stop-check carry-over note prefixes", () => {
    expect(isTaskSubjectCarryoverDeferral("Consider extracting helper")).toBe(true)
    expect(isTaskSubjectCarryoverDeferral("Future: revisit cache TTL")).toBe(true)
    expect(isTaskSubjectCarryoverDeferral("Follow-up: docs for new flag")).toBe(true)
    expect(isTaskSubjectCarryoverDeferral("Follow up: docs for new flag")).toBe(true)
    expect(isTaskSubjectCarryoverDeferral("Revisit: cache TTL after load testing")).toBe(true)
    expect(isTaskSubjectCarryoverDeferral("Revisit authentication flow design")).toBe(true)
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
