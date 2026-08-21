/**
 * Debug probe for subjectsOverlap false positives (issue #837).
 *
 * Two observed TaskCreate rejections collided completely unrelated subjects
 * with "#349d-71 Verify Codex acceptance criteria and ship". This probe runs
 * the real explainSubjectOverlap on the observed false-positive pairs, the
 * true-duplicate fixtures from subject-overlap.test.ts, and the cross-domain
 * negatives, printing which rule fired and every intermediate signal so a
 * heuristic change can be judged against all three groups at once.
 *
 * Run: bun scripts/debug-subject-overlap.ts
 */

import { explainSubjectOverlap } from "../src/subject-fingerprint.ts"

interface Case {
  label: string
  a: string
  b: string
  expected: boolean
}

const CASES: Case[] = [
  // Observed false positives (issue #837) — must NOT overlap
  {
    label: "FP1 codex-ship vs skills-issue",
    a: "Verify Codex acceptance criteria and ship",
    b: "File skills-repo issue for push guard jq bug",
    expected: false,
  },
  {
    label: "FP2 codex-ship vs report-defect",
    a: "Verify Codex acceptance criteria and ship",
    b: "Report the push-skill jq false-swallowing defect",
    expected: false,
  },
  // True duplicates from subject-overlap.test.ts — must stay overlapping
  {
    label: "TP1 commit synonyms",
    a: "Perform Git Commit and Push",
    b: "Commit staged changes with Conventional Commits message",
    expected: true,
  },
  {
    label: "TP2 stage/commit",
    a: "Stage all uncommitted changes",
    b: "Commit staged changes with Conventional Commits message",
    expected: true,
  },
  {
    label: "TP3 run/execute preflight",
    a: "Run Collaboration Guard",
    b: "Execute Task Preflight",
    expected: true,
  },
  {
    label: "TP4 worktree clean",
    a: "Verify working tree is clean",
    b: "Stage all uncommitted changes",
    expected: true,
  },
  {
    label: "TP5 push verification",
    a: "Verify Push Success with Hard Gate",
    b: "Perform Git Commit and Push",
    expected: true,
  },
  // Cross-domain negatives — must stay non-overlapping
  {
    label: "TN1 docs vs auth",
    a: "Update README documentation",
    b: "Fix authentication bug",
    expected: false,
  },
  {
    label: "TN2 migration vs ci",
    a: "Run database migration",
    b: "Verify CI status",
    expected: false,
  },
]

let asExpected = 0
for (const c of CASES) {
  const x = explainSubjectOverlap(c.a, c.b)
  const ok = x.overlap === c.expected
  if (ok) asExpected++
  console.log(`--- ${c.label} ${ok ? "PASS" : "FAIL"} ---`)
  console.log(`  a: "${c.a}"`)
  console.log(`  b: "${c.b}"`)
  console.log(`  wordsA (${x.wordsA.length}): ${x.wordsA.join(", ")}`)
  console.log(`  wordsB (${x.wordsB.length}): ${x.wordsB.join(", ")}`)
  console.log(`  overlapRatio: ${x.overlapRatio.toFixed(2)}`)
  console.log(
    `  sharedDomain: ${x.sharedDomain ?? "none"}  densityA: ${x.domainDensityA.toFixed(2)}  densityB: ${x.domainDensityB.toFixed(2)}`
  )
  console.log(`  verbA: ${x.verbA ?? "none"}  verbB: ${x.verbB ?? "none"}`)
  console.log(`  overlap: ${x.overlap} (expected ${c.expected})  rule: ${x.rule ?? "none"}`)
}
console.log(`\n${asExpected}/${CASES.length} cases behave as expected`)
