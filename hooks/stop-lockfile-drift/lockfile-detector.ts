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

const DEP_SECTIONS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const

export type PkgJson = Record<string, unknown> & {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  packageManager?: string
}

/** Parse the pre-change version of `pkgFile` via `git show <base>:<file>`. */
async function readOldPkgJson(ctx: LockfileDriftContext, pkgFile: string): Promise<PkgJson | null> {
  const base = ctx.range.includes("..") ? (ctx.range.split("..")[0] ?? "HEAD") : ctx.range
  const raw = await git(["show", `${base}:${pkgFile}`], ctx.cwd)
  if (!raw) return null
  try {
    return JSON.parse(raw) as PkgJson
  } catch {
    return null
  }
}

/** Parse the current on-disk version of `pkgFile`. */
async function readNewPkgJson(ctx: LockfileDriftContext, pkgFile: string): Promise<PkgJson | null> {
  try {
    const text = await Bun.file(`${ctx.cwd}/${pkgFile}`).text()
    return JSON.parse(text) as PkgJson
  } catch {
    return null
  }
}

/**
 * Pure comparison of the dependency-relevant fields between two parsed
 * package.json objects. Exposed so tests can cover the drift classifier
 * without constructing a git fixture.
 */
export function pkgJsonDepsChanged(oldPkg: PkgJson, newPkg: PkgJson): boolean {
  for (const section of DEP_SECTIONS) {
    if (!sameDepMap(oldPkg[section], newPkg[section])) return true
  }
  if (oldPkg.packageManager !== newPkg.packageManager) return true
  return false
}

function sameDepMap(
  a: Record<string, string> | undefined,
  b: Record<string, string> | undefined
): boolean {
  const left = a ?? {}
  const right = b ?? {}
  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(right).sort()
  if (leftKeys.length !== rightKeys.length) return false
  for (let i = 0; i < leftKeys.length; i++) {
    const key = leftKeys[i]!
    if (key !== rightKeys[i]) return false
    if (left[key] !== right[key]) return false
  }
  return true
}

/**
 * Compare dependency-relevant fields in package.json before vs. after the diff
 * range. Script changes, field reorders, whitespace edits, and metadata-only
 * updates (name/version/description) do not count as drift.
 */
async function depsActuallyChangedBetween(
  ctx: LockfileDriftContext,
  pkgFile: string
): Promise<boolean> {
  const [oldPkg, newPkg] = await Promise.all([
    readOldPkgJson(ctx, pkgFile),
    readNewPkgJson(ctx, pkgFile),
  ])
  if (!oldPkg || !newPkg) {
    // Fall back to assuming a change when we can't parse either side — safer
    // than silently ignoring a real drift.
    return true
  }
  return pkgJsonDepsChanged(oldPkg, newPkg)
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

  // Parse each candidate's package.json before + after and compare dep sections
  // directly. A line-by-line diff scan false-positives on script/metadata
  // edits (e.g. bumping a "test" script line).
  const driftChecks = await Promise.all(
    candidates.map(async ({ pkgFile, lockfileInfo }) => ({
      pkgFile,
      lockfileInfo,
      drifted: await depsActuallyChangedBetween(ctx, pkgFile),
    }))
  )

  const drifted: DriftedPackage[] = []
  for (const { pkgFile, lockfileInfo, drifted: isDrifted } of driftChecks) {
    if (!isDrifted) continue
    drifted.push({
      pkgFile,
      lockfile: lockfileInfo!.lockfile,
      installCmd: lockfileInfo!.installCmd,
    })
  }

  return drifted
}
