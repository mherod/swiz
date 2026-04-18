import { chmod, stat } from "node:fs/promises"
import type { CheckResult, DiagnosticCheck } from "../types.ts"
import { collectExecutableScriptPaths } from "./shared-scripts.ts"

function buildPermissionsResult(opts: {
  fix: boolean
  paths: string[]
  notExecutable: string[]
  fixed: string[]
  fixFailed: string[]
}): CheckResult {
  const { fix, paths, notExecutable, fixed, fixFailed } = opts
  if (fix) {
    if (fixed.length === 0 && fixFailed.length === 0) {
      return {
        name: "Script execute permissions",
        status: "pass",
        detail: "all scripts already executable",
      }
    }
    if (fixFailed.length > 0) {
      return {
        name: "Script execute permissions",
        status: "fail",
        detail: `chmod failed for ${fixFailed.length} script(s): ${fixFailed.join(", ")}`,
      }
    }
    return {
      name: "Script execute permissions",
      status: "pass",
      detail: `fixed execute permissions on ${fixed.length} script(s)`,
    }
  }
  if (notExecutable.length === 0) {
    return {
      name: "Script execute permissions",
      status: "pass",
      detail: `all ${paths.length} scripts are executable`,
    }
  }
  return {
    name: "Script execute permissions",
    status: "warn",
    detail: `${notExecutable.length} script(s) missing execute permission — run: swiz doctor --fix`,
  }
}

/** Check (and optionally fix) execute permissions on all referenced hook scripts. */
async function checkScriptExecutePermissions(fix: boolean): Promise<CheckResult> {
  const paths = await collectExecutableScriptPaths()
  const notExecutable: string[] = []
  const fixed: string[] = []
  const fixFailed: string[] = []

  for (const p of paths) {
    let s: { mode: number }
    try {
      s = await stat(p)
    } catch {
      continue // missing files reported separately by existence checks
    }
    if ((s.mode & 0o100) !== 0) continue // owner execute bit set
    if (fix) {
      try {
        await chmod(p, s.mode | 0o111)
        fixed.push(p)
      } catch {
        fixFailed.push(p)
      }
    } else {
      notExecutable.push(p)
    }
  }

  return buildPermissionsResult({ fix, paths, notExecutable, fixed, fixFailed })
}

export const scriptPermissionsCheck: DiagnosticCheck = {
  name: "script-permissions",
  run: (ctx) => checkScriptExecutePermissions(ctx.fix).then((r) => [r]),
}
