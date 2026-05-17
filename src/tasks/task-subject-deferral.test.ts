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

  test("matches issue-pick subjects that defer current work", () => {
    expect(
      isTaskSubjectWorkDeferral(
        "◻ Pick next issue: feat(posts) hidden/archive visibility filtering (#1716)"
      )
    ).toBe(true)
    expect(
      isTaskSubjectWorkDeferral(
        "◻ Pick next issue: feat(posts) archive controls and Show archived UI (#1717)"
      )
    ).toBe(true)
  })

  test("matches consider-issue subjects that defer current work", () => {
    expect(
      isTaskSubjectWorkDeferral(
        "◻ Consider issue #633: reduce pretooluse-task-governance complexity"
      )
    ).toBe(true)
    expect(
      isTaskSubjectWorkDeferral(
        "◻ Consider issue #636: expose auditStrictness in swiz settings output"
      )
    ).toBe(true)
  })

  test("matches issue-selection labels that avoid naming current work", () => {
    expect(isTaskSubjectWorkDeferral("Choose next issue: fix settings output")).toBe(true)
    expect(isTaskSubjectWorkDeferral("Select issue #633: reduce governance complexity")).toBe(true)
    expect(isTaskSubjectWorkDeferral("Queue issue #636: expose auditStrictness")).toBe(true)
    expect(isTaskSubjectWorkDeferral("Candidate issue #700: improve CI output")).toBe(true)
    expect(isTaskSubjectWorkDeferral("Optional pick: refactor hook routing")).toBe(true)
    expect(isTaskSubjectWorkDeferral("Shortlist next work item: improve task recovery")).toBe(true)
  })

  test("matches vague issue consideration labels", () => {
    expect(isTaskSubjectWorkDeferral("Revisit issue #633: task governance complexity")).toBe(true)
    expect(isTaskSubjectWorkDeferral("Evaluate #636: settings output")).toBe(true)
    expect(isTaskSubjectWorkDeferral("Assess issue #700 before choosing work")).toBe(true)
    expect(isTaskSubjectWorkDeferral("Plan next issue after CI")).toBe(true)
    expect(isTaskSubjectWorkDeferral("Circle back to issue #701")).toBe(true)
    expect(isTaskSubjectWorkDeferral("Return to #702: hook cleanup")).toBe(true)
  })

  test("matches soft time-based issue deferrals", () => {
    expect(isTaskSubjectWorkDeferral("Maybe issue #633 if time")).toBe(true)
    expect(isTaskSubjectWorkDeferral("If time, issue #636 settings output")).toBe(true)
    expect(isTaskSubjectWorkDeferral("When time allows, review issue #700")).toBe(true)
    expect(isTaskSubjectWorkDeferral("Fix issue #701 after this session")).toBe(true)
    expect(isTaskSubjectWorkDeferral("Leave the CI cleanup for tomorrow")).toBe(true)
    expect(isTaskSubjectWorkDeferral("Reserve hook cleanup for next sprint")).toBe(true)
  })

  test("matches copied terminal tree markers before deferral subjects", () => {
    expect(
      isTaskSubjectWorkDeferral("⎿  ◻ Consider issue #636: expose auditStrictness in settings")
    ).toBe(true)
  })

  test("matches to/for/until next sprint or release", () => {
    expect(isTaskSubjectWorkDeferral("Save this fix for next sprint")).toBe(true)
    expect(isTaskSubjectWorkDeferral("Hold until next release")).toBe(true)
    expect(isTaskSubjectWorkDeferral("Push to next iteration")).toBe(true)
    expect(isTaskSubjectWorkDeferral("Next sprint: fix auth bug")).toBe(true)
    expect(isTaskSubjectWorkDeferral("Next release: bump deps")).toBe(true)
  })

  test("matches all Follow-up: tasks regardless of verb", () => {
    expect(isTaskSubjectWorkDeferral("Follow-up: consider issue #633")).toBe(true)
    expect(isTaskSubjectWorkDeferral("Follow-up: revisit cache TTL strategy")).toBe(true)
    expect(isTaskSubjectWorkDeferral("Follow-up: assess issue #633 for next session")).toBe(true)
    expect(
      isTaskSubjectWorkDeferral("Follow-up: expose auditStrictness in swiz settings output")
    ).toBe(true)
    expect(
      isTaskSubjectWorkDeferral("Follow-up: reduce complexity of pretooluse-task-governance.ts")
    ).toBe(true)
    expect(isTaskSubjectWorkDeferral("Follow-up: docs for new flag")).toBe(true)
    expect(isTaskSubjectWorkDeferral("Follow-up: implement the verified fix")).toBe(true)
  })

  test("matches someday/eventually/hold leading words", () => {
    expect(isTaskSubjectWorkDeferral("Someday: migrate to new framework")).toBe(true)
    expect(isTaskSubjectWorkDeferral("Eventually: add dark mode")).toBe(true)
    expect(isTaskSubjectWorkDeferral("Hold: auth refactor")).toBe(true)
    expect(isTaskSubjectWorkDeferral("Hold off: billing changes")).toBe(true)
  })

  test("does not match legitimate current-session work", () => {
    expect(isTaskSubjectWorkDeferral("Implement deferred image loading")).toBe(false)
    expect(isTaskSubjectWorkDeferral("Add session token refresh logic")).toBe(false)
    expect(isTaskSubjectWorkDeferral("Refactor carry-over validation logic")).toBe(false)
    expect(isTaskSubjectWorkDeferral("Fix issue #633 task governance complexity")).toBe(false)
    expect(isTaskSubjectWorkDeferral("Implement issue #636 settings output")).toBe(false)
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
