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

import { blockStop, getDefaultBranch, git, isGitRepo } from "./hook-utils.ts"
import { stopHookInputSchema } from "./schemas.ts"

// ── Diff scanning (exported for testing) ────────────────────────────────────

export interface PermissionViolation {
  affectedFiles: string[]
  matchingLines: string[]
}

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

async function main(): Promise<void> {
  const input = stopHookInputSchema.parse(await Bun.stdin.json())
  const cwd = input.cwd ?? process.cwd()

  if (!(await isGitRepo(cwd))) return

  const branch = await git(["branch", "--show-current"], cwd)
  if (!branch) return // detached HEAD

  const defaultBranch = await getDefaultBranch(cwd)

  // Only enforce on non-default branches — default branch changes are intentional
  if (branch === defaultBranch) return

  // Check recent commits (since divergence from default branch) for workflow
  // permission changes. Use merge-base to find the fork point.
  const mergeBase = await git(["merge-base", defaultBranch, "HEAD"], cwd)
  if (!mergeBase) return // No common ancestor — likely a new branch with no upstream

  // Get the diff of workflow files between merge-base and HEAD
  const diffOutput = await git(
    ["diff", mergeBase, "HEAD", "--", ".github/workflows/*.yml", ".github/workflows/*.yaml"],
    cwd
  )

  const violation = scanDiffForPermissions(diffOutput)
  if (!violation) return

  blockStop(
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
    ].join("\n")
  )
}

if (import.meta.main) void main()
