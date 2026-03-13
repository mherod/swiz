#!/usr/bin/env bun
// Stop hook: Run project lint and typecheck scripts before allowing stop

import { join } from "node:path"
import { blockStop, detectPackageManager } from "./hook-utils.ts"
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

async function runScript(
  pm: string,
  scriptName: string,
  cwd: string
): Promise<{ passed: boolean; output: string }> {
  const proc = Bun.spawn([pm, "run", scriptName], { cwd, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited
  return { passed: proc.exitCode === 0, output: (stdout + stderr).trim() }
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
  if (!scripts) return

  const lintScript = findScript(scripts, LINT_SCRIPTS)
  const typecheckScript = findScript(scripts, TYPECHECK_SCRIPTS)

  if (!lintScript && !typecheckScript) return

  const pm = (await detectPackageManager()) ?? "npm"
  const failures: string[] = []

  for (const scriptName of [lintScript, typecheckScript]) {
    if (!scriptName) continue
    const { passed, output } = await runScript(pm, scriptName, cwd)
    if (!passed) {
      failures.push(`\`${pm} run ${scriptName}\` failed:\n${output}`)
      break // fail-fast
    }
  }

  if (failures.length === 0) return

  let reason = "Quality checks failed — fix all issues before stopping.\n\n"
  reason += failures.join("\n\n")
  reason += "\n\nFix every issue and try stopping again."

  blockStop(reason, { includeUpdateMemoryAdvice: false })
}

if (import.meta.main) void main()
