#!/usr/bin/env bun
// Stop hook: Run project lint and typecheck scripts before allowing stop
// Uses git state and settings to provide context-aware remediation guidance.
//
// Dual-mode: SwizStopHook for inline dispatch + subprocess via runSwizHookAsMain.

import { join } from "node:path"
import { formatActionPlan } from "../src/action-plan.ts"
import { getOpenPrForBranch, git } from "../src/git-helpers.ts"
import type { SwizHookOutput, SwizHookRunContext, SwizStopHook } from "../src/SwizHook.ts"
import { runSwizHookAsMain } from "../src/SwizHook.ts"
import { type StopHookInput, stopHookInputSchema } from "../src/schemas.ts"
import { getDefaultBranch, isDefaultBranch } from "../src/utils/git-utils.ts"
import { blockStopObj } from "../src/utils/hook-response.ts"
import { detectPackageManagerDetails } from "../src/utils/package-detection.ts"
import { type SpawnWithTimeoutResult, spawnWithTimeout } from "../src/utils/process-utils.ts"
import { evaluateWorktreePreservation } from "../src/worktree-preservation.ts"

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

export const QUALITY_HOOK_TIMEOUT_MS = 120_000
const QUALITY_CLEANUP_MS = 5_000
const MAX_FAILURE_SUMMARY_LINES = 40
const DIAGNOSTIC_LINE_RE =
  /^(?:[\w./-]+:\d+:\d+\s|Found \d+|Checked \d+|[×!] |\S*ELIFECYCLE|Command failed|TIMEOUT:)/

export function summarizeCheckOutput(output: string): string {
  const lines = output.trim().split(/\r?\n/).filter(Boolean)
  if (lines.length <= MAX_FAILURE_SUMMARY_LINES) return output.trim()

  const diagnosticLines = lines
    .map((line) => line.trimEnd())
    .filter((line) => DIAGNOSTIC_LINE_RE.test(line.trim()))
    .slice(0, MAX_FAILURE_SUMMARY_LINES)

  const kept =
    diagnosticLines.length > 0 ? diagnosticLines : lines.slice(0, MAX_FAILURE_SUMMARY_LINES)
  const omitted = Math.max(0, lines.length - kept.length)
  return `${kept.join("\n")}\n\n(Output trimmed: ${omitted} more line(s). Run the command for full details.)`
}

export interface QualityCheckResult {
  status: "passed" | "failed" | "timeout" | "unavailable"
  command: string
  output: string
}

export interface QualityCheckBudget {
  timeoutMs: number
  hookTimeoutMs: number
  signal?: AbortSignal
}

export function qualityCheckBudget(
  context?: SwizHookRunContext,
  elapsedMs = 0
): QualityCheckBudget {
  const requestedMs = context?.timeoutMs ?? QUALITY_HOOK_TIMEOUT_MS
  const hookTimeoutMs = Number.isFinite(requestedMs)
    ? Math.max(0, Math.min(requestedMs, QUALITY_HOOK_TIMEOUT_MS))
    : QUALITY_HOOK_TIMEOUT_MS
  return {
    timeoutMs: Math.max(0, hookTimeoutMs - QUALITY_CLEANUP_MS - elapsedMs),
    hookTimeoutMs,
    signal: context?.signal,
  }
}

export async function runQualityScript(
  pm: string,
  scriptName: string,
  cwd: string,
  budget: QualityCheckBudget = qualityCheckBudget()
): Promise<QualityCheckResult> {
  const command = `${pm} run ${scriptName}`
  const budgets = `Check budget: ${budget.timeoutMs / 1000}s; hook budget: ${budget.hookTimeoutMs / 1000}s.`
  if (budget.timeoutMs <= 0) {
    return { status: "timeout", command, output: `No execution time remains. ${budgets}` }
  }
  try {
    const result = await spawnWithTimeout([pm, "run", scriptName], {
      cwd,
      timeoutMs: budget.timeoutMs,
      signal: budget.signal,
      killProcessGroup: true,
    })
    return classifyQualityExecution(result, command, budgets)
  } catch (error) {
    return {
      status: "unavailable",
      command,
      output: `Could not execute the check: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

export function classifyQualityExecution(
  result: SpawnWithTimeoutResult,
  command: string,
  budgets: string
): QualityCheckResult {
  const output = (result.stdout + result.stderr).trim()
  if (result.aborted) {
    return {
      status: "unavailable",
      command,
      output: `Verification was cancelled. ${budgets}\n${output}`.trim(),
    }
  }
  if (result.timedOut) {
    return {
      status: "timeout",
      command,
      output: `Execution deadline exceeded. ${budgets}\n${output}`.trim(),
    }
  }
  if (result.exitCode === null) {
    return {
      status: "unavailable",
      command,
      output: `No terminal exit status was received.\n${output}`.trim(),
    }
  }
  if (result.exitCode === 126 || result.exitCode === 127) {
    return {
      status: "unavailable",
      command,
      output: `Could not execute a script command (exit ${result.exitCode}).\n${output}`.trim(),
    }
  }
  return {
    status: result.exitCode === 0 ? "passed" : "failed",
    command,
    output: result.exitCode === 0 ? output : `Exit ${result.exitCode}.\n${output}`.trim(),
  }
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

interface QualityCheckPr {
  mergeable: string
  number: number
  url: string
}

export function buildFeatureBranchActionSteps(
  defaultBranch: string,
  isSolo: boolean,
  pr: QualityCheckPr | null,
  preserveViaPr: boolean
): string[] {
  const steps: string[] = ["Fix all errors on this branch", "Commit and push the fixes"]
  if (preserveViaPr) {
    steps.push(
      pr
        ? `Keep PR #${pr.number} open as the recovery path (${pr.url})`
        : "Open a PR to preserve this conflicting worktree branch"
    )
    return steps
  }

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

async function buildFeatureBranchSteps(
  branch: string,
  defaultBranch: string,
  isSolo: boolean,
  cwd: string
): Promise<string[]> {
  const pr = await getOpenPrForBranch<QualityCheckPr>(branch, cwd, "mergeable,number,url").catch(
    () => null
  )
  const preservation = await evaluateWorktreePreservation({
    cwd,
    branch,
    defaultBranch,
    trunkMode: false,
    ...(pr?.mergeable === "CONFLICTING" ? { conflictsWithDefault: true as const } : {}),
  })

  return buildFeatureBranchActionSteps(defaultBranch, isSolo, pr, preservation.preserveViaPr)
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

  return `${reason}\n\n${formatActionPlan([
    "Fix all issues",
    "Commit your fixes",
    "If in detached HEAD, save work to a new branch: `git switch -c <name>`",
    "Push changes before stopping",
  ])}`
}

async function collectQualityResults(
  resolved: { lint: string | null; typecheck: string | null },
  cwd: string,
  startedAt: number,
  context?: SwizHookRunContext
): Promise<QualityCheckResult[]> {
  const selection = await detectPackageManagerDetails(cwd)
  if (!selection) {
    return [
      {
        status: "unavailable",
        command: "",
        output:
          "Cannot select a package manager safely. Add an explicit packageManager declaration or a project lockfile; no verification command was run.",
      },
    ]
  }
  const pm = selection.packageManager
  const scriptNames = [resolved.lint, resolved.typecheck].filter((s): s is string => s !== null)
  const budget = qualityCheckBudget(context, Date.now() - startedAt)
  const results = await Promise.all(scriptNames.map((s) => runQualityScript(pm, s, cwd, budget)))
  return results.map((result) => ({
    ...result,
    output: `${result.output}\nSelection: ${pm}; root: ${selection.root}; evidence: ${selection.source}; command cwd: ${cwd}`,
  }))
}

export async function qualityResultsResponse(
  results: QualityCheckResult[],
  ctx: QualityBlockContext
): Promise<SwizHookOutput> {
  const incomplete = results.filter((result) => result.status !== "passed")
  if (incomplete.length === 0) return {}
  const details = incomplete.map((result) => {
    const status = result.status === "failed" ? "failed" : `${result.status} (unverified)`
    return `${result.command ? `\`${result.command}\` ${status}:\n` : ""}${summarizeCheckOutput(result.output)}`
  })
  if (incomplete.some((result) => result.status === "failed")) {
    return blockStopObj(await buildQualityBlockReason(details, ctx))
  }
  return blockStopObj(
    `Quality checks remain unverified.\n\n${details.join("\n\n")}\n\n` +
      "Complete verification before stopping. Re-run the listed commands in the reported command cwd and investigate execution or timing problems. " +
      "An incomplete run does not establish lint or type errors."
  )
}

export async function evaluateStopQualityChecks(
  input: StopHookInput,
  context?: SwizHookRunContext
): Promise<SwizHookOutput> {
  const startedAt = Date.now()
  const raw = input as Record<string, any>
  if (!isQualityChecksEnabled(raw)) return {}
  const parsed = stopHookInputSchema.parse(input)
  const cwd = parsed.cwd ?? process.cwd()
  const resolved = await resolveScripts(cwd)
  if (!resolved) return {}

  const results = await collectQualityResults(resolved, cwd, startedAt, context)
  const settings = (raw._effectiveSettings as Record<string, any>) ?? {}
  return await qualityResultsResponse(results, { cwd, settings })
}

const stopQualityChecks: SwizStopHook = {
  name: "stop-quality-checks",
  event: "stop",
  timeout: QUALITY_HOOK_TIMEOUT_MS / 1000,
  requiredSettings: ["qualityChecksGate"],

  run(input, context) {
    return evaluateStopQualityChecks(input, context)
  },
}

export default stopQualityChecks

if (import.meta.main) {
  await runSwizHookAsMain(stopQualityChecks)
}
