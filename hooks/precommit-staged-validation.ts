#!/usr/bin/env bun

// PreCommit hook: Validate staged files for merge conflict markers and focused tests.
// Dispatched by lefthook pre-commit via `swiz dispatch preCommit`.
// Uses the blocking strategy — returns blockStopObj to fail the commit.

import { runSwizHookAsMain } from "../src/RunSwizHookAsMain.ts"
import type { SwizHook, SwizHookOutput } from "../src/SwizHook.ts"
import { blockStopObj, git, isGitRepo } from "../src/utils/hook-utils.ts"
import { preCommitHookInputSchema } from "./schemas.ts"

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

export async function evaluatePrecommitStagedValidation(input: unknown): Promise<SwizHookOutput> {
  try {
    const parsed = preCommitHookInputSchema.parse(input)
    const cwd = parsed.cwd ?? process.cwd()

    if (!(await isGitRepo(cwd))) return {}

    const stagedFiles = await getStagedFiles(cwd)
    if (stagedFiles.length === 0) return {}

    const diff = await getStagedDiff(cwd)
    const findings = scanDiff(diff)

    if (findings.length === 0) return {}

    return blockStopObj(formatReason(findings))
  } catch {
    return {}
  }
}

const precommitStagedValidation: SwizHook<Record<string, unknown>> = {
  name: "precommit-staged-validation",
  event: "preCommit",
  scheduled: true,
  timeout: 10,
  run(input) {
    return evaluatePrecommitStagedValidation(input)
  },
}

export default precommitStagedValidation

if (import.meta.main) {
  await runSwizHookAsMain(precommitStagedValidation)
}
