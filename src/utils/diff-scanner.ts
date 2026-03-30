// Shared types and utilities for stop hooks that scan git diffs for violations.

import type { HookOutput } from "../../hooks/schemas.ts"
import { stopHookInputSchema } from "../../hooks/schemas.ts"
import { blockStopObj, exitWithHookObject, getDefaultBranch, git, isGitRepo } from "./hook-utils.ts"

/** Violation result shared by all diff-scanning stop hooks. */
export interface DiffViolation {
  affectedFiles: string[]
  matchingLines: string[]
}

interface DiffScanStopHookOptions {
  /** Git pathspecs to scope the diff (e.g. "*.ts", ".github/workflows/*.yml"). */
  diffPathspecs: readonly string[]
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
 * Evaluate a diff-scan stop hook (non-default branch only). Returns `{}` when no block.
 */
export async function evaluateDiffScanStopHook(
  opts: DiffScanStopHookOptions,
  input: unknown
): Promise<HookOutput | Record<string, never>> {
  const parsed = stopHookInputSchema.parse(input)
  const cwd = parsed.cwd ?? process.cwd()

  if (!(await isGitRepo(cwd))) return {}

  const branch = await git(["branch", "--show-current"], cwd)
  if (!branch) return {}

  const defaultBranch = await getDefaultBranch(cwd)
  if (branch === defaultBranch) return {}

  const mergeBase = await git(["merge-base", defaultBranch, "HEAD"], cwd)
  if (!mergeBase) return {}

  const diffOutput = await git(["diff", mergeBase, "HEAD", "--", ...opts.diffPathspecs], cwd)

  const violation = opts.scanDiff(diffOutput)
  if (!violation) return {}

  return blockStopObj(opts.buildBlockMessage(branch, defaultBranch, mergeBase, violation))
}

/**
 * Shared main() scaffold for stop hooks that scan committed diffs on non-default branches.
 * Handles: input parsing → git repo check → branch check → merge-base → diff → scan → block.
 */
export async function runDiffScanStopHook(opts: DiffScanStopHookOptions): Promise<void> {
  const data = await Bun.stdin.json()
  const out = await evaluateDiffScanStopHook(opts, data)
  if (out && Object.keys(out).length > 0) {
    exitWithHookObject(out as HookOutput)
  }
}
