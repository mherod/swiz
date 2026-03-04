import { describe, expect, test } from "bun:test"
import { computeSubjectFingerprint, stemWord } from "../hooks/hook-utils.ts"
import {
  normalizeSubject,
  significantWords,
  subjectsOverlap,
} from "../hooks/stop-completion-auditor.ts"

describe("normalizeSubject", () => {
  test("lowercases and strips punctuation", () => {
    expect(normalizeSubject("Push backward-compat error commit")).toBe(
      "push backward compat error commit"
    )
  })

  test("collapses multiple spaces", () => {
    expect(normalizeSubject("Verify  CI   for  commit")).toBe("verify ci for commit")
  })

  test("strips special characters", () => {
    expect(normalizeSubject("Task #98: Push (main)")).toBe("task 98 push main")
  })
})

describe("significantWords", () => {
  test("filters out stop words and short tokens", () => {
    const words = significantWords("push the backward compat error commit to main")
    expect(words.has("push")).toBe(true)
    expect(words.has("backward")).toBe(true)
    expect(words.has("commit")).toBe(true)
    expect(words.has("the")).toBe(false)
    expect(words.has("to")).toBe(false)
  })

  test("filters tokens with 2 or fewer characters", () => {
    const words = significantWords("ci is ok go")
    expect(words.has("is")).toBe(false)
    expect(words.has("ok")).toBe(false)
    expect(words.has("go")).toBe(false)
  })
})

describe("subjectsOverlap", () => {
  test("detects overlapping task subjects", () => {
    expect(
      subjectsOverlap(
        normalizeSubject("Push backward-compat error commit"),
        normalizeSubject("Push backward-compat commit")
      )
    ).toBe(true)
  })

  test("detects verify CI duplicates", () => {
    expect(
      subjectsOverlap(
        normalizeSubject("Verify CI for backward-compat commit"),
        normalizeSubject("Verify CI for commit 11afbc8")
      )
    ).toBe(true)
  })

  test("rejects unrelated subjects", () => {
    expect(
      subjectsOverlap(
        normalizeSubject("Push backward-compat error commit"),
        normalizeSubject("Implement stale-task deduplication")
      )
    ).toBe(false)
  })

  test("rejects when one subject is empty", () => {
    expect(subjectsOverlap("", normalizeSubject("Push commit"))).toBe(false)
  })

  test("handles identical subjects", () => {
    const s = normalizeSubject("Verify CI status")
    expect(subjectsOverlap(s, s)).toBe(true)
  })

  test("handles subjects with different word order", () => {
    expect(
      subjectsOverlap(
        normalizeSubject("Commit and push CLAUDE.md update"),
        normalizeSubject("Push CLAUDE.md commit update")
      )
    ).toBe(true)
  })
})

describe("stemWord", () => {
  test("stems -ing forms", () => {
    expect(stemWord("committing")).toBe("commit")
    expect(stemWord("verifying")).toBe("verify")
    expect(stemWord("pushing")).toBe("push")
    expect(stemWord("formatting")).toBe("format")
    expect(stemWord("running")).toBe("run")
    expect(stemWord("checking")).toBe("check")
  })

  test("stems -ed forms", () => {
    expect(stemWord("committed")).toBe("commit")
    expect(stemWord("verified")).toBe("verify")
    expect(stemWord("pushed")).toBe("push")
    expect(stemWord("formatted")).toBe("format")
    expect(stemWord("checked")).toBe("check")
  })

  test("stems -tion and -ment", () => {
    expect(stemWord("implementation")).toBe("implement")
    expect(stemWord("verification")).toBe("verific")
    expect(stemWord("deployment")).toBe("deploy")
  })

  test("stems -s plurals", () => {
    expect(stemWord("commits")).toBe("commit")
    expect(stemWord("changes")).toBe("chang")
    expect(stemWord("tasks")).toBe("task")
  })

  test("leaves short words unchanged", () => {
    expect(stemWord("fix")).toBe("fix")
    expect(stemWord("run")).toBe("run")
    expect(stemWord("add")).toBe("add")
  })
})

describe("computeSubjectFingerprint", () => {
  test("produces deterministic output", () => {
    const fp1 = computeSubjectFingerprint("Push backward-compat error commit")
    const fp2 = computeSubjectFingerprint("Push backward-compat error commit")
    expect(fp1).toBe(fp2)
  })

  test("is order-independent", () => {
    const fp1 = computeSubjectFingerprint("Push backward-compat commit")
    const fp2 = computeSubjectFingerprint("commit backward-compat Push")
    expect(fp1).toBe(fp2)
  })

  test("ignores punctuation and case", () => {
    const fp1 = computeSubjectFingerprint("Push backward-compat commit")
    const fp2 = computeSubjectFingerprint("push backward compat COMMIT")
    expect(fp1).toBe(fp2)
  })

  test("ignores stop words", () => {
    const fp1 = computeSubjectFingerprint("Push the commit to main")
    const fp2 = computeSubjectFingerprint("Push commit main")
    expect(fp1).toBe(fp2)
  })

  test("differs for unrelated subjects", () => {
    const fp1 = computeSubjectFingerprint("Push backward-compat error commit")
    const fp2 = computeSubjectFingerprint("Implement stale-task deduplication")
    expect(fp1).not.toBe(fp2)
  })

  test("returns a hex string", () => {
    const fp = computeSubjectFingerprint("Verify CI status")
    expect(fp).toMatch(/^[0-9a-f]+$/)
  })

  test("identical subjects produce identical fingerprints", () => {
    const fp1 = computeSubjectFingerprint("Verify CI for commit 11afbc8")
    const fp2 = computeSubjectFingerprint("Verify CI for commit 11afbc8")
    expect(fp1).toBe(fp2)
  })

  // ── Synonym matching ────────────────────────────────────────────────────

  test("matches verify/check synonyms", () => {
    const fp1 = computeSubjectFingerprint("Verify CI status")
    const fp2 = computeSubjectFingerprint("Check CI status")
    expect(fp1).toBe(fp2)
  })

  test("matches confirm/validate to verify", () => {
    const fp1 = computeSubjectFingerprint("Confirm CI passes")
    const fp2 = computeSubjectFingerprint("Validate CI passes")
    expect(fp1).toBe(fp2)
  })

  test("matches implement/add/create synonyms", () => {
    const fp1 = computeSubjectFingerprint("Implement task fingerprinting")
    const fp2 = computeSubjectFingerprint("Add task fingerprinting")
    expect(fp1).toBe(fp2)
  })

  test("matches fix/resolve synonyms", () => {
    const fp1 = computeSubjectFingerprint("Fix lint errors")
    const fp2 = computeSubjectFingerprint("Resolve lint errors")
    expect(fp1).toBe(fp2)
  })

  test("matches update/modify synonyms", () => {
    const fp1 = computeSubjectFingerprint("Update CLAUDE.md rules")
    const fp2 = computeSubjectFingerprint("Modify CLAUDE.md rules")
    expect(fp1).toBe(fp2)
  })

  test("matches push/deploy synonyms", () => {
    const fp1 = computeSubjectFingerprint("Push changes to origin")
    const fp2 = computeSubjectFingerprint("Deploy changes to origin")
    expect(fp1).toBe(fp2)
  })

  test("matches remove/delete synonyms", () => {
    const fp1 = computeSubjectFingerprint("Remove dead code")
    const fp2 = computeSubjectFingerprint("Delete dead code")
    expect(fp1).toBe(fp2)
  })

  // ── Stemming ────────────────────────────────────────────────────────────

  test("matches inflected forms via stemming", () => {
    const fp1 = computeSubjectFingerprint("Committing the changes")
    const fp2 = computeSubjectFingerprint("Commit the changes")
    expect(fp1).toBe(fp2)
  })

  test("matches -ing and base form", () => {
    const fp1 = computeSubjectFingerprint("Verifying CI status")
    const fp2 = computeSubjectFingerprint("Verify CI status")
    expect(fp1).toBe(fp2)
  })

  test("matches -ed and base form", () => {
    const fp1 = computeSubjectFingerprint("Pushed changes to main")
    const fp2 = computeSubjectFingerprint("Push changes to main")
    expect(fp1).toBe(fp2)
  })

  // ── Combined stemming + synonym ─────────────────────────────────────────

  test("matches stemmed synonym (checking = verify)", () => {
    const fp1 = computeSubjectFingerprint("Checking CI results")
    const fp2 = computeSubjectFingerprint("Verify CI results")
    expect(fp1).toBe(fp2)
  })

  test("matches creating = implement via stem + synonym", () => {
    const fp1 = computeSubjectFingerprint("Creating task fingerprint")
    const fp2 = computeSubjectFingerprint("Implement task fingerprint")
    expect(fp1).toBe(fp2)
  })
})
