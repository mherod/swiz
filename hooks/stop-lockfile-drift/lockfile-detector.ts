/**
 * Lockfile detection and drift analysis.
 *
 * Detects supported lockfiles, identifies package.json changes,
 * and determines which packages have drifted without lockfile updates.
 */

import { dirname } from "node:path"
import { isNodeModulesPath } from "../../src/node-modules-path.ts"
import { git } from "../../src/utils/hook-utils.ts"
import type { DriftedPackage, LockfileDriftContext, LockfileInfo } from "./types.ts"

const LOCKFILE_MAP: Record<string, string> = {
  "pnpm-lock.yaml": "pnpm install",
  "shrinkwrap.yaml": "pnpm install",
  "yarn.lock": "yarn install",
  "package-lock.json": "npm install",
  "npm-shrinkwrap.json": "npm install",
}

/**
 * Detect lockfile for a given package directory.
 */
export async function detectLockfile(cwd: string, pkgDir: string): Promise<LockfileInfo | null> {
  for (const [lf, cmd] of Object.entries(LOCKFILE_MAP)) {
    const lfPath = pkgDir === "." ? lf : `${pkgDir}/${lf}`
    if (await Bun.file(`${cwd}/${lfPath}`).exists()) {
      return { lockfile: lfPath, installCmd: cmd }
    }
  }
  return null
}

/**
 * Check root-level lockfile coverage once for the entire scan.
 *
 * Returns true when a root-level lockfile exists and was changed,
 * meaning it covers all nested package changes.
 */
async function rootLockfileCovers(cwd: string, changedFiles: Set<string>): Promise<boolean> {
  for (const rootLf of Object.keys(LOCKFILE_MAP)) {
    if ((await Bun.file(`${cwd}/${rootLf}`).exists()) && changedFiles.has(rootLf)) {
      return true
    }
  }
  return false
}

/**
 * Analyze package.json diff to detect actual dependency changes.
 */
function depsActuallyChanged(pkgDiff: string): boolean {
  const lines = pkgDiff.split("\n")
  const depsChanged = lines.some(
    (line) =>
      line.startsWith("+") &&
      !line.startsWith("+++") &&
      /(dependencies|devDependencies|peerDependencies|optionalDependencies)/.test(line)
  )
  const depLineAdded = lines.some(
    (line) => line.startsWith("+") && !line.startsWith("+++") && /^\+\s+"[^"]+": "[^"]+"/.test(line)
  )
  return depsChanged || depLineAdded
}

/**
 * Parse a batched git diff result to extract per-file diffs.
 * Splits on `diff --git a/` headers to attribute hunks to their source file.
 */
function batchDiffPerFile(raw: string): Map<string, string> {
  const result = new Map<string, string>()
  const parts = raw.split(/\ndiff --git a\//)

  for (const part of parts) {
    if (!part.trim()) continue
    const full = part.startsWith("diff --git a/") ? part : `diff --git a/${part}`
    const match = full.match(/^diff --git a\/[^ ]+ b\/([^\n]+)/)
    if (match) {
      result.set(match[1]!, full)
    }
  }

  return result
}

/**
 * Find packages with drifted lockfiles.
 *
 * Uses a single `git diff` subprocess for all changed package.json files
 * (instead of one per file), and parallel lockfile detection via Promise.all.
 */
export async function findDriftedPackages(ctx: LockfileDriftContext): Promise<DriftedPackage[]> {
  const changedPkgs = [...ctx.changedFiles].filter(
    (f) => f.endsWith("package.json") && !isNodeModulesPath(f)
  )

  if (changedPkgs.length === 0) return []

  // Parallel lockfile detection for all packages at once
  const lockfileResults = await Promise.all(
    changedPkgs.map(async (pkgFile) => {
      const pkgDir = dirname(pkgFile)
      const lockfileInfo = await detectLockfile(ctx.cwd, pkgDir)
      return { pkgFile, pkgDir, lockfileInfo }
    })
  )

  // Check root lockfile coverage once (not per-package)
  const rootCovers = await rootLockfileCovers(ctx.cwd, ctx.changedFiles)

  // Filter to packages needing drift check
  const candidates = lockfileResults.filter(({ lockfileInfo, pkgDir }) => {
    if (!lockfileInfo) return false
    if (ctx.changedFiles.has(lockfileInfo.lockfile)) return false
    if (pkgDir !== "." && rootCovers) return false
    return true
  })

  if (candidates.length === 0) return []

  // Batch all git diff calls into a single subprocess
  const diffArgs = ["diff", ctx.range, "--", ...candidates.map((c) => c.pkgFile)]
  const rawDiff = await git(diffArgs, ctx.cwd)
  if (!rawDiff) return []

  const perFileDiffs = batchDiffPerFile(rawDiff)
  const drifted: DriftedPackage[] = []

  for (const { pkgFile, lockfileInfo } of candidates) {
    const pkgDiff = perFileDiffs.get(pkgFile)
    if (!pkgDiff) continue
    if (depsActuallyChanged(pkgDiff)) {
      drifted.push({
        pkgFile,
        lockfile: lockfileInfo!.lockfile,
        installCmd: lockfileInfo!.installCmd,
      })
    }
  }

  return drifted
}
