#!/usr/bin/env bun
// Stop hook: Run lint-staged if configured in project
//
// Dual-mode: SwizStopHook for inline dispatch + subprocess via runSwizHookAsMain.

import { join } from "node:path"
import type { SwizHookOutput, SwizStopHook } from "../src/SwizHook.ts"
import { runSwizHookAsMain } from "../src/SwizHook.ts"
import { blockStopObj } from "../src/utils/hook-utils.ts"
import type { PackageManager } from "../src/utils/package-detection.ts"
import { spawnWithTimeout } from "../src/utils/process-utils.ts"
import { type StopHookInput, stopHookInputSchema } from "./schemas.ts"

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
  let pkg: Record<string, any>
  try {
    pkg = (await Bun.file(pkgPath).json()) as Record<string, any>
  } catch {
    return null
  }
  const scripts = pkg.scripts as Record<string, any> | undefined
  const devDeps = pkg.devDependencies as Record<string, any> | undefined
  const deps = pkg.dependencies as Record<string, any> | undefined
  const hasScript = !!scripts?.["lint-staged"]
  const hasDep = !!devDeps?.["lint-staged"] || !!deps?.["lint-staged"]
  if (!hasScript && !hasDep) return null
  return { hasScript, hasDep }
}

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

export async function evaluateStopLintStaged(input: StopHookInput): Promise<SwizHookOutput> {
  const parsed = stopHookInputSchema.parse(input)
  const cwd = parsed.cwd ?? process.cwd()

  const detected = await detectLintStaged(cwd)
  if (!detected) return {}

  const { exitCode, output } = await runLintStaged(cwd, detected)
  if (exitCode === 0) return {}
  if (/could not find any staged files|no staged files/i.test(output)) return {}

  return blockStopObj(
    "The linter is the authority. Lint-staged checks failed—do not ignore them.\n\n" +
      "Linting failures must be fixed. You cannot postpone, negotiate with, or work around them.\n\n" +
      `Failures:\n${output}\n\n` +
      "Fix every linting issue, then try stopping again."
  )
}

const stopLintStaged: SwizStopHook = {
  name: "stop-lint-staged",
  event: "stop",
  timeout: 30,

  run(input) {
    return evaluateStopLintStaged(input)
  },
}

export default stopLintStaged

if (import.meta.main) {
  await runSwizHookAsMain(stopLintStaged)
}
