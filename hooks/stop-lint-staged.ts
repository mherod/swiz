#!/usr/bin/env bun
// Stop hook: Run lint-staged if configured in project

import { existsSync } from "node:fs"
import { join } from "node:path"
import { blockStop, detectPackageManager } from "./hook-utils.ts"
import { stopHookInputSchema } from "./schemas.ts"

async function main(): Promise<void> {
  const input = stopHookInputSchema.parse(await Bun.stdin.json())
  const cwd = input.cwd ?? process.cwd()
  const pkgPath = join(cwd, "package.json")

  if (!existsSync(pkgPath)) return

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

  // Detect package manager — override cwd-based detection to use this project
  process.chdir(cwd)
  const pm = detectPackageManager() ?? "npm"

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
