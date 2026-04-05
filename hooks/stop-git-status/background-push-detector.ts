/**
 * Background push detection.
 *
 * Uses process inspection (pgrep, ps, lsof) to detect if a git push
 * is currently running in the background for this repository.
 */

import { git } from "../../src/utils/hook-utils.ts"
import { spawnWithTimeout } from "../../src/utils/process-utils.ts"

const PROC_INSPECT_TIMEOUT_MS = 2_500

interface ParentMap {
  get(pid: number): number | undefined
}

/**
 * Build a map of process parent relationships from ps output.
 */
function buildParentMap(psAllOut: string): ParentMap {
  const parentMap = new Map<number, number>()
  for (const line of psAllOut.trim().split("\n").slice(1)) {
    const parts = line.trim().split(/\s+/)
    const pid = parseInt(parts[0] ?? "", 10)
    const ppid = parseInt(parts[1] ?? "", 10)
    if (!Number.isNaN(pid) && !Number.isNaN(ppid)) parentMap.set(pid, ppid)
  }
  return parentMap
}

/**
 * Collect all ancestors of a given process.
 */
function collectAncestors(parentMap: ParentMap, startPpid: number): Set<number> {
  const ancestors = new Set<number>()
  let cur = startPpid
  for (let i = 0; i < 20 && cur > 1; i++) {
    ancestors.add(cur)
    const ppid = parentMap.get(cur)
    if (!ppid || ppid === cur) break
    cur = ppid
  }
  return ancestors
}

/**
 * Check if lsof output shows access to the git repository.
 */
function checkLsofForRepoPush(lsofOut: string, gitRoot: string): boolean {
  if (!gitRoot) return false
  for (const line of lsofOut.split("\n")) {
    if (line.startsWith("n") && line.slice(1).startsWith(gitRoot)) {
      return true
    }
  }
  return false
}

/**
 * Detect if a git push is currently running in the background.
 * Returns true if a non-ancestor git push process has the repo open.
 */
export async function detectBackgroundPush(cwd: string): Promise<boolean> {
  const pgrepResult = await spawnWithTimeout(["pgrep", "-f", "git push"], {
    timeoutMs: PROC_INSPECT_TIMEOUT_MS,
  })
  if (pgrepResult.timedOut || pgrepResult.exitCode !== 0) return false

  const pushPids = pgrepResult.stdout.trim().split("\n").map(Number).filter(Boolean)

  // Parallelize ps and git rev-parse
  const [psResult, gitRoot] = await Promise.all([
    spawnWithTimeout(["ps", "-eo", "pid,ppid"], {
      timeoutMs: PROC_INSPECT_TIMEOUT_MS,
    }),
    git(["rev-parse", "--show-toplevel"], cwd),
  ])

  if (psResult.timedOut) return false

  const parentMap = buildParentMap(psResult.stdout)
  const ancestors = collectAncestors(parentMap, process.ppid)

  const nonAncestorPids = pushPids.filter((pid) => !ancestors.has(pid))
  if (nonAncestorPids.length === 0) return false

  const lsofResult = await spawnWithTimeout(
    ["lsof", "-p", nonAncestorPids.join(","), "-d", "cwd", "-Fn"],
    { timeoutMs: PROC_INSPECT_TIMEOUT_MS }
  )

  return !lsofResult.timedOut && checkLsofForRepoPush(lsofResult.stdout, gitRoot)
}
