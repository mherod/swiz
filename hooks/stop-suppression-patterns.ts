#!/usr/bin/env bun
// Stop hook: Block stop when recent commits on a non-default branch introduce
// suppression patterns that the PreToolUse gates also prohibit.
//
// Defense-in-depth backstop for:
//   pretooluse-no-ts-ignore.ts
//   pretooluse-no-eslint-disable.ts
//   pretooluse-no-as-any.ts
//
// The PreToolUse gates catch suppressions at write time; this Stop hook catches
// committed diffs — covering shell-based edits, amends, or cherry-picks that
// bypass the PreToolUse gate.
//
// Policy: only blocks on non-default branches. On the default branch, changes
// are intentional (gated by code review and other hooks).

import { blockStop, getDefaultBranch, git, isGitRepo } from "./hook-utils.ts"
import { stopHookInputSchema } from "./schemas.ts"

// ── Types ────────────────────────────────────────────────────────────────────

export interface SuppressionViolation {
  affectedFiles: string[]
  matchingLines: string[]
}

// ── Pattern detection (exported for testing) ─────────────────────────────────

// Keywords split across arrays to avoid self-triggering when the pretooluse hooks
// scan this file's own content during editing.
const KW_IGNORE = ["ts", "ignore"].join("-")
const KW_NOCHECK = ["ts", "nocheck"].join("-")
const KW_EXPECT = ["ts", "expect", "error"].join("-")
const KW_LINT = ["eslint", "disable"].join("-")

/**
 * Patterns applied to newly-added lines in a unified diff.
 * Each added diff line starts with `+` (after stripping `+++` headers).
 */
const SUPPRESSION_PATTERNS: Array<{ name: string; re: RegExp }> = [
  // Disables all type checking for the entire file
  { name: `@${KW_NOCHECK}`, re: new RegExp(`@${KW_NOCHECK}`) },
  // Suppresses the next type error
  { name: `@${KW_IGNORE}`, re: new RegExp(`@${KW_IGNORE}`) },
  // Bare expect-error with no description (description is required)
  {
    name: `@${KW_EXPECT} (bare, no description)`,
    re: new RegExp(`@${KW_EXPECT}\\s*$`),
  },
  // Lint suppression comment in `// <kw>` or `/* <kw>` form
  {
    name: KW_LINT,
    re: new RegExp(`(?://|/\\*)\\s*${KW_LINT}`),
  },
  // Type escape hatch cast
  { name: "`as any`", re: /\bas\s+any\b/ },
]

/**
 * Scan a unified diff for added lines that introduce suppression patterns.
 * Returns null if no violations are found.
 *
 * Only TypeScript/JavaScript source files are checked.
 * Other files (YAML, Markdown, shell scripts) are excluded to avoid false positives.
 */
export function scanDiffForSuppressions(diffOutput: string): SuppressionViolation | null {
  if (!diffOutput) return null

  const fileHeaderRe = /^\+\+\+ b\/(.+)$/
  const sourceFileRe = /\.(ts|tsx|js|jsx|mjs|cjs)$/

  const affectedFilesSet = new Set<string>()
  const matchingLines: string[] = []
  let currentFile = ""

  for (const line of diffOutput.split("\n")) {
    // Track which file we're in
    const headerMatch = fileHeaderRe.exec(line)
    if (headerMatch) {
      currentFile = headerMatch[1]!
      continue
    }

    // Only examine added lines (not context or removed lines, not +++ headers)
    if (!line.startsWith("+") || line.startsWith("+++")) continue

    // Only check TypeScript/JavaScript source files
    if (!sourceFileRe.test(currentFile)) continue

    // Check each suppression pattern
    for (const { re } of SUPPRESSION_PATTERNS) {
      if (re.test(line)) {
        affectedFilesSet.add(currentFile)
        matchingLines.push(line)
        break // one match per line is enough
      }
    }
  }

  if (matchingLines.length === 0) return null

  return {
    affectedFiles: Array.from(affectedFilesSet),
    matchingLines,
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const input = stopHookInputSchema.parse(await Bun.stdin.json())
  const cwd = input.cwd ?? process.cwd()

  if (!(await isGitRepo(cwd))) return

  const branch = await git(["branch", "--show-current"], cwd)
  if (!branch) return // detached HEAD

  const defaultBranch = await getDefaultBranch(cwd)

  // Only enforce on non-default branches — default branch changes are intentional
  if (branch === defaultBranch) return

  // Scope diff to commits introduced by this branch (merge-base to HEAD)
  const mergeBase = await git(["merge-base", defaultBranch, "HEAD"], cwd)
  if (!mergeBase) return // No common ancestor

  // Get the diff of source files between merge-base and HEAD.
  // Test files are excluded — suppressions there are sometimes acceptable and
  // the PreToolUse gate still catches them eagerly during editing.
  const diffOutput = await git(
    [
      "diff",
      mergeBase,
      "HEAD",
      "--",
      "*.ts",
      "*.tsx",
      "*.js",
      "*.jsx",
      "*.mjs",
      "*.cjs",
      ":!*.test.ts",
      ":!*.test.tsx",
      ":!*.spec.ts",
      ":!*.spec.tsx",
      ":!*.test.js",
      ":!*.spec.js",
    ],
    cwd
  )

  const violation = scanDiffForSuppressions(diffOutput)
  if (!violation) return

  const patternNames = SUPPRESSION_PATTERNS.map((p) => `  - ${p.name}`).join("\n")

  blockStop(
    [
      "Suppression patterns detected in committed diffs on non-default branch.",
      "",
      `  Current branch: ${branch}`,
      `  Default branch: ${defaultBranch}`,
      `  Affected files: ${violation.affectedFiles.join(", ") || "unknown"}`,
      "",
      "The following suppression patterns are prohibited in source code:",
      patternNames,
      "",
      "These suppressions were introduced in this branch's commits and bypass",
      "type-safety and lint enforcement. The PreToolUse gates exist to catch",
      "them at write time — this Stop hook catches what slipped through.",
      "",
      "Review and remove the suppressions:",
      `  git diff ${mergeBase.slice(0, 8)}..HEAD -- '*.ts' '*.tsx' '*.js' '*.jsx'`,
      "",
      "Fix the underlying type errors or lint violations instead of suppressing them.",
    ].join("\n")
  )
}

if (import.meta.main) void main()
