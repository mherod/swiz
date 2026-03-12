// Package manager and runtime detection for hook scripts.
// Walks up from CWD looking for lockfiles. Cached per process.

import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"

export type PackageManager = "bun" | "pnpm" | "yarn" | "npm"
export type Runtime = "bun" | "node"

let _pmCache: PackageManager | null | undefined

const VALID_PMS = new Set(["bun", "pnpm", "yarn", "npm"] as const)

function detectFromPkgJson(dir: string): PackageManager | null {
  const pkgJsonPath = join(dir, "package.json")
  if (!existsSync(pkgJsonPath)) return null
  try {
    const content = readFileSync(pkgJsonPath, "utf-8")
    const pkg = JSON.parse(content)
    if (pkg.packageManager && typeof pkg.packageManager === "string") {
      const pmName = pkg.packageManager.split("@")[0]
      if (VALID_PMS.has(pmName)) return pmName as PackageManager
    }
  } catch {
    // Invalid JSON, continue to other methods
  }
  return null
}

function detectFromNpmrc(dir: string): boolean {
  const npmrcPath = join(dir, ".npmrc")
  if (!existsSync(npmrcPath)) return false
  try {
    const content = readFileSync(npmrcPath, "utf-8")
    return (
      /^\s*node-linker\s*=\s*hoisted/m.test(content) ||
      /^\s*shamefully-hoist\s*=\s*true/m.test(content) ||
      /^\s*strict-peer-dependencies\s*=\s*false/m.test(content)
    )
  } catch {
    return false
  }
}

function detectFromLockfiles(dir: string): PackageManager | null {
  if (existsSync(join(dir, "bun.lockb")) || existsSync(join(dir, "bun.lock"))) return "bun"
  if (existsSync(join(dir, "pnpm-lock.yaml")) || existsSync(join(dir, "shrinkwrap.yaml")))
    return "pnpm"
  if (
    existsSync(join(dir, "yarn.lock")) ||
    existsSync(join(dir, ".pnp.cjs")) ||
    existsSync(join(dir, ".pnp.js"))
  )
    return "yarn"
  if (existsSync(join(dir, "package-lock.json")) || existsSync(join(dir, "npm-shrinkwrap.json")))
    return "npm"
  return null
}

export function detectPackageManager(): PackageManager | null {
  if (_pmCache !== undefined) return _pmCache

  let dir = process.cwd()
  while (true) {
    const fromPkg = detectFromPkgJson(dir)
    if (fromPkg) {
      _pmCache = fromPkg
      return _pmCache
    }

    if (detectFromNpmrc(dir)) {
      _pmCache = "pnpm"
      return _pmCache
    }

    const fromLockfile = detectFromLockfiles(dir)
    if (fromLockfile) {
      _pmCache = fromLockfile
      return _pmCache
    }

    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  _pmCache = null
  return null
}

export async function detectRuntime(): Promise<Runtime> {
  const pm = detectPackageManager()
  return pm === "bun" ? "bun" : "node"
}

/** The "run package" command for the detected PM (e.g. bunx, pnpm dlx, npx) */
export async function detectPkgRunner(): Promise<string> {
  const pm = detectPackageManager()
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
