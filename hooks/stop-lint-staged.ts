#!/usr/bin/env bun
// Stop hook: Run lint-staged if configured in project

import { join } from "node:path"
import { blockStop } from "./hook-utils.ts"
import { stopHookInputSchema } from "./schemas.ts"

type PackageManager = "bun" | "pnpm" | "yarn" | "npm"

async function detectPackageManagerForProject(cwd: string): Promise<PackageManager> {
  if (
    (await Bun.file(join(cwd, "bun.lockb")).exists()) ||
    (await Bun.file(join(cwd, "bun.lock")).exists())
  ) {
    return "bun"
  }
  if (
    (await Bun.file(join(cwd, "pnpm-lock.yaml")).exists()) ||
    (await Bun.file(join(cwd, "shrinkwrap.yaml")).exists())
  ) {
    return "pnpm"
  }
  if (
    (await Bun.file(join(cwd, "yarn.lock")).exists()) ||
    (await Bun.file(join(cwd, ".pnp.cjs")).exists()) ||
    (await Bun.file(join(cwd, ".pnp.js")).exists())
  ) {
    return "yarn"
  }
  return "npm"
}

async function main(): Promise<void> {
  const input = stopHookInputSchema.parse(await Bun.stdin.json())
  const cwd = input.cwd ?? process.cwd()
  const pkgPath = join(cwd, "package.json")

  if (!(await Bun.file(pkgPath).exists())) return

  let pkg: Record<string, unknown>
  try {
    pkg = (await Bun.file(pkgPath).json()) as Record<string, unknown>
  } catch {
    return
  }

  const scripts = pkg.scripts as Record<string, unknown> | undefined
  const devDeps = pkg.devDependencies as Record<string, unknown> | undefined
  const deps = pkg.dependencies as Record<string, unknown> | undefined
  const hasScript = !!scripts?.["lint-staged"]
  const hasDep = !!devDeps?.["lint-staged"] || !!deps?.["lint-staged"]

  if (!hasScript && !hasDep) return

  const pm = await detectPackageManagerForProject(cwd)

  // Run lint-staged
  const cmd = hasScript ? [pm, "run", "lint-staged"] : ["npx", "--yes", "lint-staged"]

  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited

  if (proc.exitCode === 0) return

  // "No staged files" is not a failure
  const combined = stdout + stderr
  if (/could not find any staged files|no staged files/i.test(combined)) return

  let reason = "The linter is the authority. Lint-staged checks failed—do not ignore them.\n\n"
  reason +=
    "Linting failures must be fixed. You cannot postpone, negotiate with, or work around them.\n\n"
  reason += `Failures:\n${combined}\n\n`
  reason += "Fix every linting issue, then try stopping again."

  // Lint failures are quality gates, not workflow-memory misses.
  blockStop(reason, { includeUpdateMemoryAdvice: false })
}

main()
