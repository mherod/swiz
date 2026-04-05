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
 * Check if root-level lockfile covers the given changed files.
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
 * Find packages with drifted lockfiles.
 */
export async function findDriftedPackages(ctx: LockfileDriftContext): Promise<DriftedPackage[]> {
  const drifted: DriftedPackage[] = []

  // Get list of changed package.json files
  const changedPkgs = [...ctx.changedFiles].filter(
    (f) => f.endsWith("package.json") && !isNodeModulesPath(f)
  )

  if (changedPkgs.length === 0) return []

  for (const pkgFile of changedPkgs) {
    const pkgDir = dirname(pkgFile)

    const lockfileInfo = await detectLockfile(ctx.cwd, pkgDir)
    if (!lockfileInfo) continue

    const { lockfile, installCmd } = lockfileInfo

    // Skip if lockfile was also changed
    if (ctx.changedFiles.has(lockfile)) continue

    // Skip if root lockfile covers this package
    if (pkgDir !== "." && (await rootLockfileCovers(ctx.cwd, ctx.changedFiles))) continue

    // Analyze the diff to see if dependencies actually changed
    const pkgDiff = await git(["diff", ctx.range, "--", pkgFile], ctx.cwd)
    if (!pkgDiff) continue

    if (depsActuallyChanged(pkgDiff)) {
      drifted.push({
        pkgFile,
        lockfile,
        installCmd,
      })
    }
  }

  return drifted
}
