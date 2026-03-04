/**
 * Framework detection utility for swiz hook conditions.
 *
 * Inspects indicator files and package.json deps to determine the tech stack
 * of a project directory. Results are cached per cwd within the process.
 *
 * Used by:
 *   - hooks/hook-utils.ts  (re-exported for hook scripts)
 *   - src/manifest.ts      (evalCondition: "framework:<name>" expressions)
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

export type Framework =
  // JS/TS frameworks
  | "nextjs"
  | "vite"
  | "express"
  | "fastify"
  | "nestjs"
  | "remix"
  | "astro"
  // Runtimes / language ecosystems
  | "bun-cli"
  | "python"
  | "go"
  | "rust"
  | "ruby"
  | "java"
  | "php"

const _frameworkCache = new Map<string, Set<Framework>>()

function readPackageDeps(dir: string): Record<string, string> {
  const pkgPath = join(dir, "package.json")
  if (!existsSync(pkgPath)) return {}
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"))
    return { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
  } catch {
    return {}
  }
}

/**
 * Detect frameworks and language ecosystems present in the given directory.
 *
 * Detection is based on indicator files and package.json dependency keys.
 * Multiple frameworks can be detected simultaneously (e.g. a monorepo root
 * may contain `go.mod` and a `next.config.ts`).
 *
 * Results are cached per resolved `cwd` for the lifetime of the process.
 */
export function detectFrameworks(cwd?: string): Set<Framework> {
  const dir = cwd ?? process.cwd()
  const cached = _frameworkCache.get(dir)
  if (cached !== undefined) return cached

  const frameworks = new Set<Framework>()
  const deps = readPackageDeps(dir)
  const allExts = ["js", "ts", "mjs", "cjs"] as const

  // ── JS/TS frameworks (config file or package.json dep) ──────────────────

  if (allExts.some((ext) => existsSync(join(dir, `next.config.${ext}`))) || "next" in deps) {
    frameworks.add("nextjs")
  }

  if (allExts.some((ext) => existsSync(join(dir, `vite.config.${ext}`))) || "vite" in deps) {
    frameworks.add("vite")
  }

  if (
    ["js", "ts"].some((ext) => existsSync(join(dir, `remix.config.${ext}`))) ||
    "@remix-run/node" in deps
  ) {
    frameworks.add("remix")
  }

  if (allExts.some((ext) => existsSync(join(dir, `astro.config.${ext}`))) || "astro" in deps) {
    frameworks.add("astro")
  }

  if ("express" in deps) frameworks.add("express")
  if ("fastify" in deps) frameworks.add("fastify")
  if ("@nestjs/core" in deps) frameworks.add("nestjs")

  // ── Language ecosystems (indicator files) ────────────────────────────────

  if (
    existsSync(join(dir, "pyproject.toml")) ||
    existsSync(join(dir, "setup.py")) ||
    existsSync(join(dir, "requirements.txt"))
  ) {
    frameworks.add("python")
  }

  if (existsSync(join(dir, "go.mod"))) frameworks.add("go")
  if (existsSync(join(dir, "Cargo.toml"))) frameworks.add("rust")
  if (existsSync(join(dir, "Gemfile"))) frameworks.add("ruby")
  if (existsSync(join(dir, "pom.xml")) || existsSync(join(dir, "build.gradle")))
    frameworks.add("java")
  if (existsSync(join(dir, "composer.json"))) frameworks.add("php")

  _frameworkCache.set(dir, frameworks)
  return frameworks
}

/** Clears the per-process cache. Intended for use in tests only. */
export function _clearFrameworkCache(): void {
  _frameworkCache.clear()
}
