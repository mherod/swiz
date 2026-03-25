import { describe, expect, test } from "bun:test"
import {
  computeSubjectFingerprint,
  normalizeSubject,
  significantWords,
  stemWord,
  subjectsOverlap,
} from "./subject-fingerprint.ts"

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

  test("stems irregular verb past tenses", () => {
    expect(stemWord("built")).toBe("build")
    expect(stemWord("ran")).toBe("run")
    expect(stemWord("wrote")).toBe("write")
    expect(stemWord("sent")).toBe("send")
    expect(stemWord("made")).toBe("make")
    expect(stemWord("found")).toBe("find")
    expect(stemWord("got")).toBe("get")
    expect(stemWord("took")).toBe("take")
    expect(stemWord("gave")).toBe("give")
    expect(stemWord("kept")).toBe("keep")
  })

  test("stems irregular past participles", () => {
    expect(stemWord("written")).toBe("write")
    expect(stemWord("gotten")).toBe("get")
    expect(stemWord("taken")).toBe("take")
    expect(stemWord("given")).toBe("give")
    expect(stemWord("broken")).toBe("break")
    expect(stemWord("known")).toBe("know")
    expect(stemWord("chosen")).toBe("choose")
    expect(stemWord("thrown")).toBe("throw")
    expect(stemWord("begun")).toBe("begin")
    expect(stemWord("done")).toBe("do")
  })

  test("stems broader irregular verbs", () => {
    expect(stemWord("led")).toBe("lead")
    expect(stemWord("lost")).toBe("lose")
    expect(stemWord("left")).toBe("leave")
    expect(stemWord("spent")).toBe("spend")
    expect(stemWord("thought")).toBe("think")
    expect(stemWord("bound")).toBe("bind")
    expect(stemWord("stuck")).toBe("stick")
    expect(stemWord("hidden")).toBe("hide")
    expect(stemWord("withdrawn")).toBe("withdraw")
    expect(stemWord("grown")).toBe("grow")
    expect(stemWord("drawn")).toBe("draw")
    expect(stemWord("spun")).toBe("spin")
    expect(stemWord("dealt")).toBe("deal")
    expect(stemWord("meant")).toBe("mean")
    expect(stemWord("understood")).toBe("understand")
    expect(stemWord("felt")).toBe("feel")
    expect(stemWord("taught")).toBe("teach")
    expect(stemWord("swept")).toBe("sweep")
    expect(stemWord("stolen")).toBe("steal")
    expect(stemWord("stood")).toBe("stand")
  })

  test("stems irregular plural nouns", () => {
    expect(stemWord("indices")).toBe("index")
    expect(stemWord("statuses")).toBe("status")
    expect(stemWord("branches")).toBe("branch")
    expect(stemWord("patches")).toBe("patch")
    expect(stemWord("caches")).toBe("cache")
    expect(stemWord("batches")).toBe("batch")
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

  // ── Irregular verb stems ──────────────────────────────────────────────

  test("matches built/build via irregular stem", () => {
    const fp1 = computeSubjectFingerprint("Built the new feature")
    const fp2 = computeSubjectFingerprint("Build the new feature")
    expect(fp1).toBe(fp2)
  })

  test("matches wrote/write via irregular stem", () => {
    const fp1 = computeSubjectFingerprint("Wrote migration script")
    const fp2 = computeSubjectFingerprint("Write migration script")
    expect(fp1).toBe(fp2)
  })

  test("matches ran/run via irregular stem", () => {
    const fp1 = computeSubjectFingerprint("Ran full test suite")
    const fp2 = computeSubjectFingerprint("Run full test suite")
    expect(fp1).toBe(fp2)
  })

  test("matches found/find via irregular stem", () => {
    const fp1 = computeSubjectFingerprint("Found and fix memory leak")
    const fp2 = computeSubjectFingerprint("Find and fix memory leak")
    expect(fp1).toBe(fp2)
  })

  test("matches sent/send via irregular stem", () => {
    const fp1 = computeSubjectFingerprint("Sent webhook notification")
    const fp2 = computeSubjectFingerprint("Send webhook notification")
    expect(fp1).toBe(fp2)
  })

  test("matches irregular + synonym (built = implement)", () => {
    const fp1 = computeSubjectFingerprint("Built task fingerprint")
    const fp2 = computeSubjectFingerprint("Implement task fingerprint")
    expect(fp1).toBe(fp2)
  })

  // ── Irregular plural nouns ────────────────────────────────────────────

  test("matches irregular plural (branches/branch)", () => {
    const fp1 = computeSubjectFingerprint("Clean stale branches")
    const fp2 = computeSubjectFingerprint("Clean stale branch")
    expect(fp1).toBe(fp2)
  })

  // ── Auxiliary/modal filtering ─────────────────────────────────────────

  test("ignores auxiliary verbs (has/have/been)", () => {
    const fp1 = computeSubjectFingerprint("Has been verified CI status")
    const fp2 = computeSubjectFingerprint("Verify CI status")
    expect(fp1).toBe(fp2)
  })

  test("ignores modal verbs (should/must/will)", () => {
    const fp1 = computeSubjectFingerprint("Should fix lint errors")
    const fp2 = computeSubjectFingerprint("Must fix lint errors")
    expect(fp1).toBe(fp2)
  })

  test("ignores will/would (future/conditional)", () => {
    const fp1 = computeSubjectFingerprint("Will implement feature")
    const fp2 = computeSubjectFingerprint("Implement feature")
    expect(fp1).toBe(fp2)
  })

  // ── Broader irregular stems in fingerprint ────────────────────────────

  test("matches led/lead via irregular stem", () => {
    const fp1 = computeSubjectFingerprint("Led the refactoring effort")
    const fp2 = computeSubjectFingerprint("Lead the refactoring effort")
    expect(fp1).toBe(fp2)
  })

  test("matches lost/lose via irregular stem", () => {
    const fp1 = computeSubjectFingerprint("Lost connection handler")
    const fp2 = computeSubjectFingerprint("Lose connection handler")
    expect(fp1).toBe(fp2)
  })

  test("matches left/leave via irregular stem", () => {
    const fp1 = computeSubjectFingerprint("Left TODO comments")
    const fp2 = computeSubjectFingerprint("Leave TODO comments")
    expect(fp1).toBe(fp2)
  })

  test("matches thought/think via irregular stem", () => {
    const fp1 = computeSubjectFingerprint("Thought about approach")
    const fp2 = computeSubjectFingerprint("Think about approach")
    expect(fp1).toBe(fp2)
  })
})
