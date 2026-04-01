#!/usr/bin/env bun
// Stop hook: Run project lint and typecheck scripts before allowing stop
// Uses git state and settings to provide context-aware remediation guidance.
//
// Dual-mode: SwizStopHook for inline dispatch + subprocess via runSwizHookAsMain.

import { join } from "node:path"
import { getOpenPrForBranch } from "../src/git-helpers.ts"
import type { SwizHookOutput, SwizStopHook } from "../src/SwizHook.ts"
import { runSwizHookAsMain } from "../src/SwizHook.ts"
import { getDefaultBranch, isDefaultBranch } from "../src/utils/git-utils.ts"
import {
  blockStopObj,
  detectPackageManager,
  formatActionPlan,
  git,
} from "../src/utils/hook-utils.ts"
import { spawnWithTimeout } from "../src/utils/process-utils.ts"
import { type StopHookInput, stopHookInputSchema } from "./schemas.ts"

export const LINT_SCRIPTS = ["lint", "lint:check", "eslint", "biome:check"] as const
export const TYPECHECK_SCRIPTS = ["typecheck", "type-check", "tsc", "check:types"] as const

export function findScript(
  scripts: Record<string, any>,
  candidates: readonly string[]
): string | null {
  for (const name of candidates) {
    if (typeof scripts[name] === "string") return name
  }
  return null
}

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
  scripts: Record<string, any>
  lint: string | null
  typecheck: string | null
} | null> {
  const pkgPath = join(cwd, "package.json")
  if (!(await Bun.file(pkgPath).exists())) return null
  let pkg: Record<string, any>
  try {
    pkg = (await Bun.file(pkgPath).json()) as Record<string, any>
  } catch {
    return null
  }
  const scripts = pkg.scripts as Record<string, any> | undefined
  if (!scripts) return null
  const lint = findScript(scripts, LINT_SCRIPTS)
  const typecheck = findScript(scripts, TYPECHECK_SCRIPTS)
  if (!lint && !typecheck) return null
  return { scripts, lint, typecheck }
}

export function isQualityChecksEnabled(raw: Record<string, any>): boolean {
  const settings = raw._effectiveSettings as Record<string, any> | undefined
  return !!settings?.qualityChecksGate
}

async function buildFeatureBranchSteps(
  branch: string,
  defaultBranch: string,
  isSolo: boolean,
  cwd: string
): Promise<string[]> {
  const pr = await getOpenPrForBranch<{ number: number; url: string }>(
    branch,
    cwd,
    "number,url"
  ).catch(() => null)

  const steps: string[] = ["Fix all errors on this branch", "Commit and push the fixes"]
  if (pr) {
    steps.push(
      isSolo
        ? `Merge PR #${pr.number} (${pr.url})`
        : `Merge PR #${pr.number} or request review (${pr.url})`
    )
  } else {
    steps.push(
      isSolo
        ? "Push directly — no PR required in solo mode"
        : "Open a PR and merge (or request review)"
    )
  }
  steps.push(`Switch back: \`git checkout ${defaultBranch} && git pull\``)
  return steps
}

interface QualityBlockContext {
  cwd: string
  settings: Record<string, any>
}

async function buildQualityBlockReason(
  failures: string[],
  ctx: QualityBlockContext
): Promise<string> {
  let reason = "Quality checks failed — fix all issues before stopping.\n\n"
  reason += failures.join("\n\n")
  reason +=
    "\n\nFix every lint and typecheck error, including pre-existing ones inherited from the base branch."
  reason += "\nAll errors are your responsibility regardless of who introduced them."

  const { cwd, settings } = ctx
  const trunkMode = settings.trunkMode === true
  const collaborationMode = (settings.collaborationMode as string) ?? "auto"
  const isSolo = collaborationMode === "solo"

  let currentBranch = ""
  try {
    currentBranch = (await git(["branch", "--show-current"], cwd)).trim()
  } catch {
    // Not a git repo or detached HEAD — skip branch-specific guidance.
  }

  const defaultBranch = await getDefaultBranch(cwd)
  const onDefault = currentBranch !== "" && isDefaultBranch(currentBranch, defaultBranch)

  if (trunkMode || onDefault) {
    const branchName = currentBranch || defaultBranch
    return `${reason}\n\n${formatActionPlan(
      ["Fix all lint and typecheck errors", "Commit the fixes", `Push to \`${branchName}\``],
      { header: `You are on \`${branchName}\`.` }
    )}`
  }

  if (currentBranch) {
    const steps = await buildFeatureBranchSteps(currentBranch, defaultBranch, isSolo, cwd)
    return `${reason}\n\n${formatActionPlan(steps, {
      header: `You are on feature branch \`${currentBranch}\` (default: \`${defaultBranch}\`).`,
    })}`
  }

  return `${reason}\n\n${formatActionPlan(["Fix all issues", "Commit and push before stopping"])}`
}

async function collectFailures(
  resolved: { lint: string | null; typecheck: string | null },
  cwd: string
): Promise<string[]> {
  const pm = (await detectPackageManager()) ?? "npm"
  const scriptNames = [resolved.lint, resolved.typecheck].filter((s): s is string => s !== null)
  const results = await Promise.all(scriptNames.map((s) => runScript(pm, s, cwd)))
  const failures: string[] = []
  for (let i = 0; i < results.length; i++) {
    if (!results[i]!.passed) {
      failures.push(`\`${pm} run ${scriptNames[i]}\` failed:\n${results[i]!.output}`)
    }
  }
  return failures
}

export async function evaluateStopQualityChecks(input: StopHookInput): Promise<SwizHookOutput> {
  const raw = input as Record<string, any>
  if (!isQualityChecksEnabled(raw)) return {}
  const parsed = stopHookInputSchema.parse(input)
  const cwd = parsed.cwd ?? process.cwd()
  const resolved = await resolveScripts(cwd)
  if (!resolved) return {}

  const failures = await collectFailures(resolved, cwd)
  if (failures.length === 0) return {}

  const settings = (raw._effectiveSettings as Record<string, any>) ?? {}
  return blockStopObj(await buildQualityBlockReason(failures, { cwd, settings }))
}

const stopQualityChecks: SwizStopHook = {
  name: "stop-quality-checks",
  event: "stop",
  timeout: 60,
  requiredSettings: ["qualityChecksGate"],

  run(input) {
    return evaluateStopQualityChecks(input)
  },
}

export default stopQualityChecks

if (import.meta.main) {
  await runSwizHookAsMain(stopQualityChecks)
}
