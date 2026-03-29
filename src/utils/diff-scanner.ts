// Shared types and utilities for stop hooks that scan git diffs for violations.

import { stopHookInputSchema } from "../../hooks/schemas.ts"
import { blockStop, getDefaultBranch, git, isGitRepo } from "./hook-utils.ts"

/** Violation result shared by all diff-scanning stop hooks. */
export interface DiffViolation {
  affectedFiles: string[]
  matchingLines: string[]
}

interface DiffScanStopHookOptions {
  /** Git pathspecs to scope the diff (e.g. "*.ts", ".github/workflows/*.yml"). */
  diffPathspecs: string[]
  /** Function that scans the diff output and returns a violation or null. */
  scanDiff: (diffOutput: string) => DiffViolation | null
  /** Build the block message from branch info and the violation. */
  buildBlockMessage: (
    branch: string,
    defaultBranch: string,
    mergeBase: string,
    violation: DiffViolation
  ) => string
}

/**
 * Shared main() scaffold for stop hooks that scan committed diffs on non-default branches.
 * Handles: input parsing → git repo check → branch check → merge-base → diff → scan → block.
 */
export async function runDiffScanStopHook(opts: DiffScanStopHookOptions): Promise<void> {
  const data = await Bun.stdin.json()
  const input = stopHookInputSchema.parse(data)
  const cwd = input.cwd ?? process.cwd()

  if (!(await isGitRepo(cwd))) return

  const branch = await git(["branch", "--show-current"], cwd)
  if (!branch) return // detached HEAD

  const defaultBranch = await getDefaultBranch(cwd)
  if (branch === defaultBranch) return

  const mergeBase = await git(["merge-base", defaultBranch, "HEAD"], cwd)
  if (!mergeBase) return

  const diffOutput = await git(["diff", mergeBase, "HEAD", "--", ...opts.diffPathspecs], cwd)

  const violation = opts.scanDiff(diffOutput)
  if (!violation) return

  blockStop(opts.buildBlockMessage(branch, defaultBranch, mergeBase, violation))
}
