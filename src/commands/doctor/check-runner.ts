/**
 * Doctor check runner boundary.
 *
 * This module owns diagnostic collection, report rendering, and summary/error
 * assembly for `swiz doctor`. Individual check definitions and fix-side
 * dependencies stay in `doctor.ts` so the command file can compose behavior
 * without re-embedding the runner flow.
 */

import { BOLD, DIM, GREEN, RED, RESET, YELLOW } from "../../ansi.ts"
import {
  displayPath,
  type InvalidSkillEntry,
  type PluginCacheInfo,
  type SkillConflict,
} from "../doctor/fix.ts"
import type { CheckResult, DiagnosticCheck, DiagnosticContext } from "../doctor/types.ts"

const PASS = `${GREEN}✓${RESET}`
const FAIL = `${RED}✗${RESET}`
const WARN = `${YELLOW}!${RESET}`
const SKILL_CONFLICT_PREFIX = "Skill conflict: "

export interface DoctorCheckResults {
  results: CheckResult[]
  skillConflicts: SkillConflict[]
  invalidSkillEntries: InvalidSkillEntry[]
  pluginCacheInfos: PluginCacheInfo[]
}

interface AutoFixContext {
  fix: boolean
  results: CheckResult[]
  skillConflicts: SkillConflict[]
  invalidSkillEntries: InvalidSkillEntry[]
  pluginCacheInfos: PluginCacheInfo[]
}

interface DoctorCheckRunnerDeps {
  allChecks: DiagnosticCheck[]
  handleAutoFixes(ctx: AutoFixContext): Promise<void>
  notifyDaemon(jsonOutput: boolean): Promise<void>
}

export async function collectDoctorChecks(
  fix: boolean,
  allChecks: DiagnosticCheck[]
): Promise<DoctorCheckResults> {
  const results: CheckResult[] = []
  const ctx: DiagnosticContext = { fix, store: {} }

  for (const check of allChecks) {
    const result = await check.run(ctx)
    if (Array.isArray(result)) {
      results.push(...result)
    } else {
      results.push(result)
    }
  }

  return {
    results,
    skillConflicts: (ctx.store.skillConflicts ?? []) as SkillConflict[],
    invalidSkillEntries: (ctx.store.invalidSkillEntries ?? []) as InvalidSkillEntry[],
    pluginCacheInfos: (ctx.store.pluginCacheInfos ?? []) as PluginCacheInfo[],
  }
}

function printResult(result: CheckResult): void {
  const icon = result.status === "pass" ? PASS : result.status === "warn" ? WARN : FAIL
  const detailColor = result.status === "fail" ? RED : result.status === "warn" ? YELLOW : DIM
  console.log(`  ${icon} ${BOLD}${result.name}${RESET}  ${detailColor}${result.detail}${RESET}`)
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b))
}

function buildSkillConflictSummary(conflicts: SkillConflict[]): CheckResult {
  const activeRoots = uniqueSorted(conflicts.map((conflict) => displayPath(conflict.active.dir)))
  const overriddenRoots = uniqueSorted(
    conflicts.flatMap((conflict) => conflict.overridden.map((entry) => displayPath(entry.dir)))
  )
  const overriddenCount = conflicts.reduce((sum, conflict) => sum + conflict.overridden.length, 0)
  const skillLabel = conflicts.length === 1 ? "skill name" : "skill names"
  const entryLabel = overriddenCount === 1 ? "entry" : "entries"
  return {
    name: "Skill conflicts",
    status: "warn",
    detail:
      `${conflicts.length} duplicate ${skillLabel}; active roots=${activeRoots.join(", ")}; ` +
      `overridden roots=${overriddenRoots.join(", ")}; ${overriddenCount} shadowed ${entryLabel} ` +
      "— run: swiz doctor --fix; show details: swiz doctor --verbose",
  }
}

function isSkillConflictWarning(result: CheckResult): boolean {
  return result.status === "warn" && result.name.startsWith(SKILL_CONFLICT_PREFIX)
}

function prepareResultsForDisplay(
  results: CheckResult[],
  skillConflicts: SkillConflict[],
  verbose: boolean
): CheckResult[] {
  if (verbose || skillConflicts.length === 0) return results

  const displayResults: CheckResult[] = []
  let insertedSummary = false
  for (const result of results) {
    if (!isSkillConflictWarning(result)) {
      displayResults.push(result)
      continue
    }
    if (!insertedSummary) {
      displayResults.push(buildSkillConflictSummary(skillConflicts))
      insertedSummary = true
    }
  }
  return displayResults
}

function formatSummaryCounts(
  results: CheckResult[],
  displayResults: CheckResult[],
  verbose: boolean
): string {
  const failures = results.filter((r) => r.status === "fail")
  const warnings = results.filter((r) => r.status === "warn")
  const passes = results.filter((r) => r.status === "pass")
  const displayedWarnings = displayResults.filter((r) => r.status === "warn")
  const hiddenWarningDetails = Math.max(0, warnings.length - displayedWarnings.length)
  const detail =
    !verbose && hiddenWarningDetails > 0
      ? ` (${displayedWarnings.length} shown; use --verbose for details)`
      : ""

  return (
    `  ${GREEN}${passes.length} passed${RESET}` +
    (warnings.length > 0 ? `, ${YELLOW}${warnings.length} warnings${RESET}${detail}` : "") +
    (failures.length > 0 ? `, ${RED}${failures.length} failed${RESET}` : "")
  )
}

export async function runDoctorChecks(args: string[], deps: DoctorCheckRunnerDeps): Promise<void> {
  const fix = args.includes("--fix")
  const verbose = args.includes("--verbose")
  console.log(`\n  ${BOLD}swiz doctor${RESET}\n`)

  const { results, skillConflicts, invalidSkillEntries, pluginCacheInfos } =
    await collectDoctorChecks(fix, deps.allChecks)

  const displayResults = prepareResultsForDisplay(results, skillConflicts, verbose)
  for (const result of displayResults) {
    printResult(result)
  }

  const failures = results.filter((r) => r.status === "fail")

  console.log()
  console.log(formatSummaryCounts(results, displayResults, verbose))
  console.log()

  await deps.handleAutoFixes({
    fix,
    results,
    skillConflicts,
    invalidSkillEntries,
    pluginCacheInfos,
  })

  if (failures.length > 0) {
    throw new Error(
      `${failures.length} check(s) failed:\n` +
        failures.map((failure) => `  - ${failure.name}: ${failure.detail}`).join("\n")
    )
  }

  await deps.notifyDaemon(false)
}
