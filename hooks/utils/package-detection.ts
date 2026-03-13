// Package manager and runtime detection for hook scripts.
// Walks up from CWD looking for lockfiles. Cached per process.

import { access } from "node:fs/promises"
import { dirname, join } from "node:path"

export type PackageManager = "bun" | "pnpm" | "yarn" | "npm"
export type Runtime = "bun" | "node"

let _pmCache: Promise<PackageManager | null> | undefined

const VALID_PMS = new Set(["bun", "pnpm", "yarn", "npm"] as const)

/** Async file-existence check using `access()`. */
async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

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

async function detectFromLockfiles(dir: string): Promise<PackageManager | null> {
  if ((await fileExists(join(dir, "bun.lockb"))) || (await fileExists(join(dir, "bun.lock"))))
    return "bun"
  if (
    (await fileExists(join(dir, "pnpm-lock.yaml"))) ||
    (await fileExists(join(dir, "shrinkwrap.yaml")))
  )
    return "pnpm"
  if (
    (await fileExists(join(dir, "yarn.lock"))) ||
    (await fileExists(join(dir, ".pnp.cjs"))) ||
    (await fileExists(join(dir, ".pnp.js")))
  )
    return "yarn"
  if (
    (await fileExists(join(dir, "package-lock.json"))) ||
    (await fileExists(join(dir, "npm-shrinkwrap.json")))
  )
    return "npm"
  return null
}

async function detectPackageManagerInner(): Promise<PackageManager | null> {
  let dir = process.cwd()
  while (true) {
    const fromPkg = await detectFromPkgJson(dir)
    if (fromPkg) return fromPkg

    if (await detectFromNpmrc(dir)) return "pnpm"

    const fromLockfile = await detectFromLockfiles(dir)
    if (fromLockfile) return fromLockfile

    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  return null
}

export function detectPackageManager(): Promise<PackageManager | null> {
  if (_pmCache !== undefined) return _pmCache
  _pmCache = detectPackageManagerInner()
  return _pmCache
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
