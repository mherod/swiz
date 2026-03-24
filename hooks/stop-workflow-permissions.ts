#!/usr/bin/env bun

// Stop hook: Block stop when recent commits on a non-default branch modify
// workflow `permissions:` blocks in .github/workflows/*.yml files.
//
// Defense-in-depth backstop for pretooluse-workflow-permissions-gate.ts.
// The PreToolUse gate catches permission edits at write time; this Stop hook
// catches committed diffs — covering shell-based edits, amends, or cherry-picks
// that bypass the PreToolUse gate.
//
// Policy: only blocks on non-default branches. On the default branch, workflow
// permission changes are intentional (gated by other hooks like code review).

import { type DiffViolation, runDiffScanStopHook } from "./utils/diff-scanner.ts"

export type { DiffViolation } from "./utils/diff-scanner.ts"
/** @deprecated Use DiffViolation from utils/diff-scanner.ts */
export type PermissionViolation = DiffViolation

/**
 * Scan a unified diff for added `permissions:` lines in workflow files.
 * Returns null if no violations found.
 */
export function scanDiffForPermissions(diffOutput: string): PermissionViolation | null {
  if (!diffOutput) return null

  const addedLines = diffOutput
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))

  const permissionsRe = /^\+\s*permissions\s*:/
  const matchingLines = addedLines.filter((line) => permissionsRe.test(line))

  if (matchingLines.length === 0) return null

  const fileRe = /^\+\+\+ b\/(.+)$/gm
  const affectedFiles: string[] = []
  let match: RegExpExecArray | null = fileRe.exec(diffOutput)
  while (match) {
    affectedFiles.push(match[1]!)
    match = fileRe.exec(diffOutput)
  }

  return { affectedFiles, matchingLines }
}

// ── Main ────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  void runDiffScanStopHook({
    diffPathspecs: [".github/workflows/*.yml", ".github/workflows/*.yaml"],
    scanDiff: scanDiffForPermissions,
    buildBlockMessage: (branch, defaultBranch, mergeBase, violation) =>
      [
        "Workflow permission changes detected on non-default branch.",
        "",
        `  Current branch: ${branch}`,
        `  Default branch: ${defaultBranch}`,
        `  Affected files: ${violation.affectedFiles.join(", ") || "unknown"}`,
        "",
        "GitHub Actions security model: workflow `permissions:` changes made in a",
        "PR branch do NOT take effect until merged to the default branch. This",
        "creates a dangerous blind spot:",
        "",
        "  1. The elevated permissions appear inert during PR CI",
        "  2. Reviewers may not scrutinize the change since 'it didn't break anything'",
        "  3. Upon merge, the elevated permissions silently activate",
        "",
        "Review the permission changes carefully before proceeding:",
        `  git diff ${mergeBase.slice(0, 8)}..HEAD -- .github/workflows/`,
        "",
        "If the changes are intentional, make them directly on the default branch instead.",
      ].join("\n"),
  })
}
