#!/usr/bin/env bun
// Stop hook: Run project lint and typecheck scripts before allowing stop

import { join } from "node:path"
import { readProjectSettings } from "../src/settings.ts"
import { blockStop, detectPackageManager, spawnWithTimeout } from "../src/utils/hook-utils.ts"
import { stopHookInputSchema } from "./schemas.ts"

// Script names probed in priority order for each quality category
export const LINT_SCRIPTS = ["lint", "lint:check", "eslint", "biome:check"] as const
export const TYPECHECK_SCRIPTS = ["typecheck", "type-check", "tsc", "check:types"] as const

/** Return the first script name that exists in the package.json scripts map, or null. */
export function findScript(
  scripts: Record<string, unknown>,
  candidates: readonly string[]
): string | null {
  for (const name of candidates) {
    if (typeof scripts[name] === "string") return name
  }
  return null
}

/** Per-script timeout: lint/typecheck can be slow but should never take > 45s. */
const SCRIPT_TIMEOUT_MS = 45_000

async function runScript(
  pm: string,
  scriptName: string,
  cwd: string
): Promise<{ passed: boolean; output: string }> {
  const result = await spawnWithTimeout([pm, "run", scriptName], {
    cwd,
    timeoutMs: SCRIPT_TIMEOUT_MS,
  })
  if (result.timedOut) {
    return {
      passed: false,
      output: `TIMEOUT: \`${pm} run ${scriptName}\` exceeded ${SCRIPT_TIMEOUT_MS / 1000}s`,
    }
  }
  return { passed: result.exitCode === 0, output: (result.stdout + result.stderr).trim() }
}

async function resolveScripts(cwd: string): Promise<{
  scripts: Record<string, unknown>
  lint: string | null
  typecheck: string | null
} | null> {
  const pkgPath = join(cwd, "package.json")
  if (!(await Bun.file(pkgPath).exists())) return null
  let pkg: Record<string, unknown>
  try {
    pkg = (await Bun.file(pkgPath).json()) as Record<string, unknown>
  } catch {
    return null
  }
  const scripts = pkg.scripts as Record<string, unknown> | undefined
  if (!scripts) return null
  const lint = findScript(scripts, LINT_SCRIPTS)
  const typecheck = findScript(scripts, TYPECHECK_SCRIPTS)
  if (!lint && !typecheck) return null
  return { scripts, lint, typecheck }
}

export function isQualityChecksEnabled(raw: Record<string, unknown>): boolean {
  const settings = raw._effectiveSettings as Record<string, unknown> | undefined
  return !!settings?.qualityChecksGate
}

async function buildQualityBlockReason(failures: string[], cwd: string): Promise<string> {
  let reason = "Quality checks failed — fix all issues before stopping.\n\n"
  reason += failures.join("\n\n")
  reason +=
    "\n\nFix every lint and typecheck error, including pre-existing ones inherited from the base branch."
  reason += "\nAll errors are your responsibility regardless of who introduced them."

  const trunkMode = (await readProjectSettings(cwd))?.trunkMode === true
  if (trunkMode) {
    return (
      reason +
      "\n\nTrunk mode: fix all issues on your current branch, then commit and push to the default branch before stopping."
    )
  }
  return (
    reason +
    "\n\nIf you are on a feature branch with branch protection on the default branch:" +
    "\n  1. Fix all errors on the current branch" +
    "\n  2. Commit and push the fixes" +
    "\n  3. Merge your PR (or request review if required)" +
    "\n  4. Switch back to the default branch: `git checkout main && git pull`" +
    "\n  5. Then try stopping again"
  )
}

async function main(): Promise<void> {
  const input = stopHookInputSchema.parse(await Bun.stdin.json())
  if (!isQualityChecksEnabled(input as Record<string, unknown>)) return
  const cwd = input.cwd ?? process.cwd()
  const resolved = await resolveScripts(cwd)
  if (!resolved) return

  const lintScript = resolved.lint
  const typecheckScript = resolved.typecheck

  if (!lintScript && !typecheckScript) return

  const pm = (await detectPackageManager()) ?? "npm"
  const failures: string[] = []

  // Run lint and typecheck in parallel for performance — they are independent checks.
  const scriptNames = [lintScript, typecheckScript].filter((s): s is string => s !== null)
  const results = await Promise.all(scriptNames.map((s) => runScript(pm, s, cwd)))
  for (let i = 0; i < results.length; i++) {
    if (!results[i]!.passed) {
      failures.push(`\`${pm} run ${scriptNames[i]}\` failed:\n${results[i]!.output}`)
    }
  }

  if (failures.length === 0) return

  blockStop(await buildQualityBlockReason(failures, cwd), { includeUpdateMemoryAdvice: false })
}

if (import.meta.main) void main()
