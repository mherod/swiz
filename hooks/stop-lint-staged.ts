#!/usr/bin/env bun
// Stop hook: Run lint-staged if configured in project

import { join } from "node:path"
import { stopHookInputSchema } from "./schemas.ts"
import { blockStop, spawnWithTimeout } from "./utils/hook-utils.ts"

type PackageManager = "bun" | "pnpm" | "yarn" | "npm"

const PM_LOCKFILE_MAP: Array<{ pm: PackageManager; files: string[] }> = [
  { pm: "bun", files: ["bun.lockb", "bun.lock"] },
  { pm: "pnpm", files: ["pnpm-lock.yaml", "shrinkwrap.yaml"] },
  { pm: "yarn", files: ["yarn.lock", ".pnp.cjs", ".pnp.js"] },
]

async function detectPackageManagerForProject(cwd: string): Promise<PackageManager> {
  for (const { pm, files } of PM_LOCKFILE_MAP) {
    for (const f of files) {
      if (await Bun.file(join(cwd, f)).exists()) return pm
    }
  }
  return "npm"
}

async function detectLintStaged(
  cwd: string
): Promise<{ hasScript: boolean; hasDep: boolean } | null> {
  const pkgPath = join(cwd, "package.json")
  if (!(await Bun.file(pkgPath).exists())) return null
  let pkg: Record<string, unknown>
  try {
    pkg = (await Bun.file(pkgPath).json()) as Record<string, unknown>
  } catch {
    return null
  }
  const scripts = pkg.scripts as Record<string, unknown> | undefined
  const devDeps = pkg.devDependencies as Record<string, unknown> | undefined
  const deps = pkg.dependencies as Record<string, unknown> | undefined
  const hasScript = !!scripts?.["lint-staged"]
  const hasDep = !!devDeps?.["lint-staged"] || !!deps?.["lint-staged"]
  if (!hasScript && !hasDep) return null
  return { hasScript, hasDep }
}

/** Lint-staged should finish well within 25s. */
const LINT_STAGED_TIMEOUT_MS = 25_000

async function runLintStaged(
  cwd: string,
  detected: { hasScript: boolean }
): Promise<{ exitCode: number; output: string }> {
  const pm = await detectPackageManagerForProject(cwd)
  const cmd = detected.hasScript ? [pm, "run", "lint-staged"] : ["npx", "--yes", "lint-staged"]
  const result = await spawnWithTimeout(cmd, { cwd, timeoutMs: LINT_STAGED_TIMEOUT_MS })
  if (result.timedOut) {
    return {
      exitCode: 1,
      output: `TIMEOUT: lint-staged exceeded ${LINT_STAGED_TIMEOUT_MS / 1000}s — killed`,
    }
  }
  return { exitCode: result.exitCode ?? 1, output: result.stdout + result.stderr }
}

async function main(): Promise<void> {
  const input = stopHookInputSchema.parse(await Bun.stdin.json())
  const cwd = input.cwd ?? process.cwd()

  const detected = await detectLintStaged(cwd)
  if (!detected) return

  const { exitCode, output } = await runLintStaged(cwd, detected)
  if (exitCode === 0) return
  if (/could not find any staged files|no staged files/i.test(output)) return

  blockStop(
    "The linter is the authority. Lint-staged checks failed—do not ignore them.\n\n" +
      "Linting failures must be fixed. You cannot postpone, negotiate with, or work around them.\n\n" +
      `Failures:\n${output}\n\n` +
      "Fix every linting issue, then try stopping again.",
    { includeUpdateMemoryAdvice: false }
  )
}

if (import.meta.main) void main()
