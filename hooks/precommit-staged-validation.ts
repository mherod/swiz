#!/usr/bin/env bun

// PreCommit hook: Validate staged files for merge conflict markers and focused tests.
// Dispatched by lefthook pre-commit via `swiz dispatch preCommit`.
// Uses the blocking strategy — returns { decision: "block", reason } to fail the commit.

import { preCommitHookInputSchema } from "./schemas.ts"
import { git, isGitRepo } from "./utils/hook-utils.ts"

const CONFLICT_MARKER_RE = /^[<>=]{7}( |$)/
const FOCUSED_TEST_RE = /\b(describe\.only|it\.only|test\.only|fdescribe|fit)\b/
const STAGED_SOURCE_RE = /\.(ts|tsx|js|jsx|mjs|cjs)$/
/** Files excluded from focused test scanning — hook/test files legitimately reference these patterns. */
const FOCUSED_TEST_EXCLUDE_RE = /^hooks\/|\.test\.(ts|tsx|js|jsx)$|__tests__\//

async function getStagedFiles(cwd: string): Promise<string[]> {
  const output = await git(["diff", "--cached", "--name-only", "--diff-filter=ACMR"], cwd)
  if (!output) return []
  return output
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean)
}

async function getStagedDiff(cwd: string): Promise<string> {
  return (await git(["diff", "--cached", "-U0"], cwd)) ?? ""
}

interface Finding {
  file: string
  line: string
  issue: string
}

function scanDiff(diff: string): Finding[] {
  const findings: Finding[] = []
  let currentFile = ""

  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) {
      currentFile = line.slice(6)
      continue
    }
    if (!line.startsWith("+") || line.startsWith("+++")) continue

    const addedLine = line.slice(1)

    if (CONFLICT_MARKER_RE.test(addedLine)) {
      findings.push({ file: currentFile, line: addedLine.slice(0, 80), issue: "conflict marker" })
    }

    if (
      STAGED_SOURCE_RE.test(currentFile) &&
      !FOCUSED_TEST_EXCLUDE_RE.test(currentFile) &&
      FOCUSED_TEST_RE.test(addedLine)
    ) {
      findings.push({
        file: currentFile,
        line: addedLine.trim().slice(0, 80),
        issue: "focused test",
      })
    }
  }

  return findings
}

function formatReason(findings: Finding[]): string {
  const conflicts = findings.filter((f) => f.issue === "conflict marker")
  const focused = findings.filter((f) => f.issue === "focused test")

  const parts: string[] = []

  if (conflicts.length > 0) {
    parts.push("Merge conflict markers found in staged files:")
    for (const f of conflicts) parts.push(`  ${f.file}: ${f.line}`)
  }

  if (focused.length > 0) {
    parts.push("Focused tests found in staged files (.only/fit/fdescribe):")
    for (const f of focused) parts.push(`  ${f.file}: ${f.line}`)
  }

  return parts.join("\n")
}

async function main(): Promise<void> {
  const raw = await new Response(Bun.stdin.stream()).text()
  const parsed = preCommitHookInputSchema.safeParse(JSON.parse(raw || "{}"))
  const cwd = parsed.success ? (parsed.data.cwd ?? process.cwd()) : process.cwd()

  if (!(await isGitRepo(cwd))) {
    process.exit(0)
  }

  const stagedFiles = await getStagedFiles(cwd)
  if (stagedFiles.length === 0) {
    process.exit(0)
  }

  const diff = await getStagedDiff(cwd)
  const findings = scanDiff(diff)

  if (findings.length === 0) {
    process.exit(0)
  }

  const reason = formatReason(findings)
  console.log(JSON.stringify({ decision: "block", reason }))
  process.exit(0)
}

main().catch(() => {
  // Fail open — don't block commits on hook errors
  process.exit(0)
})
