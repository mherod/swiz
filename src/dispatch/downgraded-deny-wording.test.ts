/**
 * A downgraded deny must not claim it blocked anything.
 *
 * `collectPreToolResults` intentionally downgrades some denies to advisory context — an edit gate
 * firing mid-skill would otherwise create a catch-22. But it pushed the deny's reason through
 * verbatim, and deny copy is written to prevent: it opens `BLOCKED:` and closes with a mandate to
 * act before doing anything else. After the tool was allowed, that text is simply false.
 *
 * Reported from another Claude session as three occurrences in one session, noticed only because
 * an unrelated structural assertion did not add up. The danger is not the wasted call: an agent
 * that learns tool status can lie starts re-verifying results it should be able to trust.
 */

import { describe, expect, test } from "bun:test"
import { softenDowngradedDenyReason } from "./preToolUseStrategy.ts"

/** The exact shape `preToolUseDeny` produces, as emitted by the memory-file gate. */
const REAL_DENY_REASON = [
  "BLOCKED: editing a memory file requires the Skill(update-memory) skill to be used first.",
  "",
  "The Skill(update-memory) skill has not been invoked recently (last 30 turns and last 20 minutes).",
  "",
  "To resolve:",
  "  1. Invoke the Skill(update-memory) skill, then retry this edit.",
  "",
  "You must act on this now. Do not try to stop again without completing the required action.",
].join("\n")

describe("softenDowngradedDenyReason", () => {
  const softened = softenDowngradedDenyReason(REAL_DENY_REASON)

  test("does not claim the call was blocked", () => {
    expect(softened).not.toContain("BLOCKED")
  })

  test("states plainly that the call proceeded", () => {
    expect(softened).toContain("this call was allowed to proceed")
  })

  test("drops the act-now mandate, which is meaningless after the fact", () => {
    expect(softened).not.toContain("You must act on this now")
    expect(softened).not.toContain("Do not try to stop again")
  })

  test("keeps the substance so the guidance is still actionable", () => {
    expect(softened).toContain("Skill(update-memory)")
    expect(softened).toContain("To resolve:")
  })

  test("control: the untouched reason really does carry the misleading text", () => {
    // Without this, every assertion above could pass against an input that never had the problem.
    expect(REAL_DENY_REASON).toContain("BLOCKED")
    expect(REAL_DENY_REASON).toContain("You must act on this now")
  })

  test("a reason with no BLOCKED prefix or mandate still gets the advisory prefix", () => {
    const plain = softenDowngradedDenyReason("Some guard fired.")
    expect(plain).toBe("ADVISORY (this call was allowed to proceed): Some guard fired.")
  })

  test("is idempotent enough not to stack prefixes on an already-softened reason", () => {
    const once = softenDowngradedDenyReason(REAL_DENY_REASON)
    const twice = softenDowngradedDenyReason(once)
    expect(twice.match(/this call was allowed to proceed/g)).toHaveLength(2)
    // Documents current behaviour: the caller softens exactly once, at the downgrade site.
    expect(twice.startsWith("ADVISORY")).toBe(true)
  })
})
