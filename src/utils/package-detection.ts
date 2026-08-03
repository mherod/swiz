// Package manager and runtime detection for hook scripts.
// Walks up from CWD looking for lockfiles. Cached per process.

import { dirname, join } from "node:path"
import { hasAnyFile as hasAnyLockfile } from "../detect-frameworks"
import { fileExists } from "../detect-frameworks.ts"

export type PackageManager = "bun" | "pnpm" | "yarn" | "npm"
export type Runtime = "bun" | "node"

export interface PackageManagerDetection {
  packageManager: PackageManager
  signals: ReadonlySet<PackageManager>
}

let _pmDetectionCache: Promise<PackageManagerDetection | null> | undefined

const VALID_PMS = new Set(["bun", "pnpm", "yarn", "npm"] as const)

async function detectFromPkgJson(dir: string): Promise<PackageManager | null> {
  const pkgJsonPath = join(dir, "package.json")
  try {
    const file = Bun.file(pkgJsonPath)
    if (!(await file.exists())) return null
    const pkg = (await file.json()) as { packageManager?: string }
    if (pkg.packageManager && typeof pkg.packageManager === "string") {
      const pmName = pkg.packageManager.split("@")[0]
      if (pmName && VALID_PMS.has(pmName as PackageManager)) return pmName as PackageManager
    }
  } catch {
    // Invalid JSON, continue to other methods
  }
  return null
}

async function detectFromNpmrc(dir: string): Promise<boolean> {
  const npmrcPath = join(dir, ".npmrc")
  try {
    const file = Bun.file(npmrcPath)
    if (!(await file.exists())) return false
    const content = await file.text()
    return (
      /^\s*node-linker\s*=\s*hoisted/m.test(content) ||
      /^\s*shamefully-hoist\s*=\s*true/m.test(content) ||
      /^\s*strict-peer-dependencies\s*=\s*false/m.test(content)
    )
  } catch {
    return false
  }
}

async function hasPnpmNodeModulesLock(dir: string): Promise<boolean> {
  return fileExists(join(dir, "node_modules", ".pnpm", "lock.yaml"))
}

interface LockfileDetection {
  packageManager: PackageManager | null
  signals: Set<PackageManager>
}

function collectLockfileSignals(
  hasBunLock: boolean,
  hasPnpmLock: boolean,
  hasYarnLock: boolean,
  hasNpmLock: boolean
): Set<PackageManager> {
  const signals = new Set<PackageManager>()
  if (hasBunLock) signals.add("bun")
  if (hasPnpmLock) signals.add("pnpm")
  if (hasYarnLock) signals.add("yarn")
  if (hasNpmLock) signals.add("npm")
  return signals
}

async function detectFromLockfiles(dir: string): Promise<LockfileDetection> {
  const [hasBunLock, hasPnpmLock, hasYarnLock, hasNpmLock] = await Promise.all([
    hasAnyLockfile(dir, ["bun.lockb", "bun.lock"]),
    hasAnyLockfile(dir, ["pnpm-lock.yaml", "shrinkwrap.yaml"]),
    hasAnyLockfile(dir, ["yarn.lock", ".pnp.cjs", ".pnp.js"]),
    hasAnyLockfile(dir, ["package-lock.json", "npm-shrinkwrap.json"]),
  ])
  const signals = collectLockfileSignals(hasBunLock, hasPnpmLock, hasYarnLock, hasNpmLock)

  if (hasBunLock && hasPnpmLock && (await hasPnpmNodeModulesLock(dir))) {
    return { packageManager: "pnpm", signals }
  }

  if (hasBunLock) return { packageManager: "bun", signals }
  if (hasPnpmLock) return { packageManager: "pnpm", signals }
  if (hasYarnLock) return { packageManager: "yarn", signals }
  if (hasNpmLock) return { packageManager: "npm", signals }
  return { packageManager: null, signals }
}

async function detectPackageManagerDetailsInner(
  startDir: string
): Promise<PackageManagerDetection | null> {
  let dir = startDir
  while (true) {
    const fromPkg = await detectFromPkgJson(dir)
    const fromNpmrc = await detectFromNpmrc(dir)
    const fromLockfile = await detectFromLockfiles(dir)
    const packageManager = fromPkg ?? (fromNpmrc ? "pnpm" : null) ?? fromLockfile.packageManager

    if (packageManager) {
      const signals = fromLockfile.signals
      if (fromPkg) signals.add(fromPkg)
      if (fromNpmrc) signals.add("pnpm")
      return { packageManager, signals }
    }

    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  return null
}

export function detectPackageManagerDetails(
  startDir?: string
): Promise<PackageManagerDetection | null> {
  if (startDir !== undefined) return detectPackageManagerDetailsInner(startDir)
  // Hook subprocesses now inherit the correct cwd via Bun.spawn({ cwd })
  // (commit c2185ec), so process.cwd() is the project directory.
  if (_pmDetectionCache !== undefined) return _pmDetectionCache
  _pmDetectionCache = detectPackageManagerDetailsInner(process.cwd())
  return _pmDetectionCache
}

export async function detectPackageManager(startDir?: string): Promise<PackageManager | null> {
  return (await detectPackageManagerDetails(startDir))?.packageManager ?? null
}

export async function detectRuntime(): Promise<Runtime> {
  const pm = await detectPackageManager()
  return pm === "bun" ? "bun" : "node"
}

/** The "run package" command for the detected PM (e.g. bunx, pnpm dlx, npx) */
export async function detectPkgRunner(): Promise<string> {
  const pm = await detectPackageManager()
  switch (pm) {
    case "bun":
      return "bunx"
    case "pnpm":
      return "pnpm dlx"
    case "yarn":
      return "yarn dlx"
    default:
      return "npx"
  }
}
