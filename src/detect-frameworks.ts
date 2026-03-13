/**
 * Framework detection utility for swiz hook conditions.
 *
 * Inspects indicator files and package.json deps to determine the tech stack
 * of a project directory. Results are cached per cwd within the process.
 *
 * Used by:
 *   - hooks/hook-utils.ts  (re-exported for hook scripts)
 *   - src/manifest.ts      (evalCondition: "framework:<name>" expressions)
 *   - src/commands/dispatch.ts  (filterStackHooks: stacks field filtering)
 */

import { access } from "node:fs/promises"
import { join } from "node:path"
import { resolveCwd } from "./cwd.ts"

/** Async file-existence check using `access()`. */
async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/**
 * High-level stack names used in HookDef.stacks for per-stack hook filtering.
 *
 * These map to broad language/runtime categories rather than specific frameworks.
 * A directory may match multiple stacks (e.g. a Go + Next.js monorepo matches
 * both "go" and "node").
 *
 * Stable across releases — these become part of the manifest DSL.
 */
export type ProjectStack = "bun" | "node" | "go" | "python" | "ruby" | "rust" | "java" | "php"

const _stackCache = new Map<string, Promise<ProjectStack[]>>()

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

const _frameworkCache = new Map<string, Promise<Set<Framework>>>()

const JS_TS_EXTENSIONS = ["js", "ts", "mjs", "cjs"] as const
const PYTHON_INDICATOR_FILES = ["pyproject.toml", "setup.py", "requirements.txt"] as const
const JAVA_INDICATOR_FILES = ["pom.xml", "build.gradle"] as const

async function hasAnyFile(dir: string, files: readonly string[]): Promise<boolean> {
  for (const file of files) {
    if (await fileExists(join(dir, file))) return true
  }
  return false
}

async function hasConfigFile(
  dir: string,
  baseName: string,
  extensions: readonly string[]
): Promise<boolean> {
  for (const ext of extensions) {
    if (await fileExists(join(dir, `${baseName}.${ext}`))) return true
  }
  return false
}

function hasDependency(deps: Record<string, string>, name: string): boolean {
  return name in deps
}

async function readPackageDeps(dir: string): Promise<Record<string, string>> {
  const pkgPath = join(dir, "package.json")
  try {
    const file = Bun.file(pkgPath)
    if (!(await file.exists())) return {}
    const pkg = (await file.json()) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
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
export async function detectFrameworks(cwd?: string): Promise<Set<Framework>> {
  const dir = resolveCwd(cwd)
  const cached = _frameworkCache.get(dir)
  if (cached !== undefined) return cached

  const promise = detectFrameworksInner(dir)
  _frameworkCache.set(dir, promise)
  return promise
}

async function detectFrameworksInner(dir: string): Promise<Set<Framework>> {
  const frameworks = new Set<Framework>()
  const deps = await readPackageDeps(dir)

  // ── JS/TS frameworks (config file or package.json dep) ──────────────────

  if ((await hasConfigFile(dir, "next.config", JS_TS_EXTENSIONS)) || hasDependency(deps, "next")) {
    frameworks.add("nextjs")
  }

  if ((await hasConfigFile(dir, "vite.config", JS_TS_EXTENSIONS)) || hasDependency(deps, "vite")) {
    frameworks.add("vite")
  }

  if (
    (await hasConfigFile(dir, "remix.config", ["js", "ts"] as const)) ||
    hasDependency(deps, "@remix-run/node")
  ) {
    frameworks.add("remix")
  }

  if (
    (await hasConfigFile(dir, "astro.config", JS_TS_EXTENSIONS)) ||
    hasDependency(deps, "astro")
  ) {
    frameworks.add("astro")
  }

  if (hasDependency(deps, "express")) frameworks.add("express")
  if (hasDependency(deps, "fastify")) frameworks.add("fastify")
  if (hasDependency(deps, "@nestjs/core")) frameworks.add("nestjs")

  // ── Language ecosystems (indicator files) ────────────────────────────────

  if (await hasAnyFile(dir, PYTHON_INDICATOR_FILES)) frameworks.add("python")
  if (await fileExists(join(dir, "go.mod"))) frameworks.add("go")
  if (await fileExists(join(dir, "Cargo.toml"))) frameworks.add("rust")
  if (await fileExists(join(dir, "Gemfile"))) frameworks.add("ruby")
  if (await hasAnyFile(dir, JAVA_INDICATOR_FILES)) frameworks.add("java")
  if (await fileExists(join(dir, "composer.json"))) frameworks.add("php")

  return frameworks
}

/** Clears the per-process cache. Intended for use in tests only. */
export function _clearFrameworkCache(): void {
  _frameworkCache.clear()
  _stackCache.clear()
}

/**
 * Detect the high-level project stacks present in the given directory.
 *
 * Returns a sorted array of `ProjectStack` names.  Multiple stacks can be
 * returned for polyglot repos (e.g. `["go", "node"]`).
 *
 * Stack → indicator mapping:
 *   bun    — bun.lockb or bun.lock present
 *   node   — package.json present without a bun lockfile
 *   go     — go.mod present
 *   python — pyproject.toml / setup.py / requirements.txt present
 *   ruby   — Gemfile present
 *   rust   — Cargo.toml present
 *   java   — pom.xml or build.gradle present
 *   php    — composer.json present
 *
 * Results are cached per resolved `cwd` for the lifetime of the process.
 */
export async function detectProjectStack(cwd?: string): Promise<string[]> {
  const dir = resolveCwd(cwd)
  const cached = _stackCache.get(dir)
  if (cached !== undefined) return cached

  const promise = detectProjectStackInner(dir)
  _stackCache.set(dir, promise)
  return promise
}

async function detectProjectStackInner(dir: string): Promise<ProjectStack[]> {
  const stacks: ProjectStack[] = []

  const hasBunLock =
    (await fileExists(join(dir, "bun.lockb"))) || (await fileExists(join(dir, "bun.lock")))
  const hasPkg = await fileExists(join(dir, "package.json"))

  if (hasBunLock) {
    stacks.push("bun")
  } else if (hasPkg) {
    stacks.push("node")
  }

  if (await fileExists(join(dir, "go.mod"))) stacks.push("go")

  if (await hasAnyFile(dir, PYTHON_INDICATOR_FILES)) {
    stacks.push("python")
  }

  if (await fileExists(join(dir, "Gemfile"))) stacks.push("ruby")
  if (await fileExists(join(dir, "Cargo.toml"))) stacks.push("rust")
  if (await hasAnyFile(dir, JAVA_INDICATOR_FILES)) stacks.push("java")
  if (await fileExists(join(dir, "composer.json"))) stacks.push("php")

  return stacks.sort()
}
