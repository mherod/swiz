// Package manager and runtime detection for hook scripts.
// Walks up from CWD looking for lockfiles. Cached per process.

import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"

export type PackageManager = "bun" | "pnpm" | "yarn" | "npm"
export type Runtime = "bun" | "node"

let _pmCache: PackageManager | null | undefined

export function detectPackageManager(): PackageManager | null {
  if (_pmCache !== undefined) return _pmCache

  let dir = process.cwd()
  while (true) {
    // Primary: Check for packageManager field in package.json (Node.js standard)
    const pkgJsonPath = join(dir, "package.json")
    if (existsSync(pkgJsonPath)) {
      try {
        const content = readFileSync(pkgJsonPath, "utf-8")
        const pkg = JSON.parse(content)
        if (pkg.packageManager && typeof pkg.packageManager === "string") {
          // Format: "pnpm@10.29.3" → extract "pnpm"
          const pmName = pkg.packageManager.split("@")[0] as PackageManager
          if (pmName === "bun" || pmName === "pnpm" || pmName === "yarn" || pmName === "npm") {
            _pmCache = pmName
            return _pmCache
          }
        }
      } catch {
        // If package.json is invalid JSON, continue to other detection methods
      }
    }

    // Secondary: Check for pnpm-specific config hints in .npmrc
    const npmrcPath = join(dir, ".npmrc")
    if (existsSync(npmrcPath)) {
      try {
        const content = readFileSync(npmrcPath, "utf-8")
        if (
          /^\s*node-linker\s*=\s*hoisted/m.test(content) ||
          /^\s*shamefully-hoist\s*=\s*true/m.test(content) ||
          /^\s*strict-peer-dependencies\s*=\s*false/m.test(content)
        ) {
          _pmCache = "pnpm"
          return _pmCache
        }
      } catch {
        // If .npmrc is unreadable, continue to lock file detection
      }
    }

    // Tertiary: Check for lockfile signals
    if (existsSync(join(dir, "bun.lockb")) || existsSync(join(dir, "bun.lock"))) {
      _pmCache = "bun"
      return _pmCache
    }
    if (existsSync(join(dir, "pnpm-lock.yaml")) || existsSync(join(dir, "shrinkwrap.yaml"))) {
      _pmCache = "pnpm"
      return _pmCache
    }
    if (
      existsSync(join(dir, "yarn.lock")) ||
      existsSync(join(dir, ".pnp.cjs")) ||
      existsSync(join(dir, ".pnp.js"))
    ) {
      _pmCache = "yarn"
      return _pmCache
    }
    if (
      existsSync(join(dir, "package-lock.json")) ||
      existsSync(join(dir, "npm-shrinkwrap.json"))
    ) {
      _pmCache = "npm"
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
