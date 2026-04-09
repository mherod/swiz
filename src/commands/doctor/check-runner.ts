/**
 * Doctor check runner boundary.
 *
 * This module owns diagnostic collection, report rendering, and summary/error
 * assembly for `swiz doctor`. Individual check definitions and fix-side
 * dependencies stay in `doctor.ts` so the command file can compose behavior
 * without re-embedding the runner flow.
 */

import { BOLD, DIM, GREEN, RED, RESET, YELLOW } from "../../ansi.ts"
import type { InvalidSkillEntry, PluginCacheInfo, SkillConflict } from "../doctor/fix.ts"
import type { CheckResult, DiagnosticCheck, DiagnosticContext } from "../doctor/types.ts"

const PASS = `${GREEN}✓${RESET}`
const FAIL = `${RED}✗${RESET}`
const WARN = `${YELLOW}!${RESET}`

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

export async function runDoctorChecks(args: string[], deps: DoctorCheckRunnerDeps): Promise<void> {
  const fix = args.includes("--fix")
  console.log(`\n  ${BOLD}swiz doctor${RESET}\n`)

  const { results, skillConflicts, invalidSkillEntries, pluginCacheInfos } =
    await collectDoctorChecks(fix, deps.allChecks)

  for (const result of results) {
    printResult(result)
  }

  const failures = results.filter((r) => r.status === "fail")
  const warnings = results.filter((r) => r.status === "warn")
  const passes = results.filter((r) => r.status === "pass")

  console.log()
  console.log(
    `  ${GREEN}${passes.length} passed${RESET}` +
      (warnings.length > 0 ? `, ${YELLOW}${warnings.length} warnings${RESET}` : "") +
      (failures.length > 0 ? `, ${RED}${failures.length} failed${RESET}` : "")
  )
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
