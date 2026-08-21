#!/usr/bin/env bun
// Stop hook: Run lint-staged if configured in project
//
// Dual-mode: SwizStopHook for inline dispatch + subprocess via runSwizHookAsMain.

import { join } from "node:path"
import { git } from "../src/git-helpers.ts"
import type { SwizHookOutput, SwizStopHook } from "../src/SwizHook.ts"
import { runSwizHookAsMain } from "../src/SwizHook.ts"
import { type StopHookInput, stopHookInputSchema } from "../src/schemas.ts"
import { blockStopObj } from "../src/utils/hook-response.ts"
import type { PackageManager } from "../src/utils/package-detection.ts"
import { spawnWithTimeout } from "../src/utils/process-utils.ts"
import {
  resolveSessionFileOwnership,
  type SessionFileOwnership,
} from "../src/utils/session-file-ownership.ts"

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

/**
 * Always pass --no-stash: lint-staged's default backup stash is stranded when
 * the timeout kills the process mid-run, silently parking every session's
 * uncommitted work in a stash nobody knows to look for (issue #839).
 */
export function buildLintStagedCommand(pm: PackageManager, hasScript: boolean): string[] {
  return hasScript
    ? [pm, "run", "lint-staged", "--", "--no-stash"]
    : ["npx", "--yes", "lint-staged", "--no-stash"]
}

/**
 * A whole-index mutator must not run over another live session's staged or
 * dirty files — lint-staged rewrites and re-stages everything staged,
 * regardless of owner (issue #839). Unattributed files stay eligible: absence
 * of a peer's edit record is the normal solo case.
 */
export function shouldSkipForPeerOwnership(ownership: SessionFileOwnership): boolean {
  return ownership.editedByOthers.length > 0
}

async function listDirtyFiles(cwd: string): Promise<string[]> {
  try {
    const out = await git(["status", "--porcelain"], cwd)
    return out
      .split("\n")
      .map((line) => {
        const path = line.slice(3).trim()
        const renameArrow = path.lastIndexOf(" -> ")
        return renameArrow === -1 ? path : path.slice(renameArrow + 4)
      })
      .filter(Boolean)
  } catch {
    return []
  }
}

async function runLintStaged(
  cwd: string,
  detected: { hasScript: boolean }
): Promise<{ exitCode: number; output: string }> {
  const pm = await detectPackageManagerForProject(cwd)
  const cmd = buildLintStagedCommand(pm, detected.hasScript)
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

  const dirty = await listDirtyFiles(cwd)
  if (dirty.length > 0) {
    const ownership = await resolveSessionFileOwnership(cwd, parsed.session_id, dirty)
    if (shouldSkipForPeerOwnership(ownership)) return {}
  }

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
