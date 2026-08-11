import {
  ensureShimInstallation,
  inspectShimInstallation,
  type ShimInstallationOptions,
} from "../../shim.ts"
import type { CheckResult, DiagnosticCheck } from "../types.ts"

interface ShellShimCheckOptions extends ShimInstallationOptions {
  fix: boolean
}

export async function checkShellShim(options: ShellShimCheckOptions): Promise<CheckResult> {
  try {
    const before = await inspectShimInstallation(options)
    if (before.healthy) {
      return {
        name: "Shell shim installation",
        status: "pass",
        detail: "required shell profiles have the current shim",
      }
    }

    const affected = [...before.missingProfiles, ...before.outdatedProfiles]
    if (!options.fix) {
      return {
        name: "Shell shim installation",
        status: "warn",
        detail: `${affected.length} required profile(s) missing or outdated — run: swiz doctor --fix`,
      }
    }

    const repair = await ensureShimInstallation(options)
    const after = await inspectShimInstallation(options)
    if (!after.healthy) {
      return {
        name: "Shell shim installation",
        status: "fail",
        detail: "repair completed but required shell profiles are still unhealthy",
      }
    }

    const backupDetail =
      repair.backupPaths.length > 0 ? `; wrote ${repair.backupPaths.length} backup(s)` : ""
    return {
      name: "Shell shim installation",
      status: "pass",
      detail: `repaired shell shim in ${repair.changedProfiles.length} profile(s)${backupDetail}`,
    }
  } catch (error) {
    return {
      name: "Shell shim installation",
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

export const shellShimCheck: DiagnosticCheck = {
  name: "shell-shim",
  run: (ctx) => checkShellShim({ fix: ctx.fix }).then((result) => [result]),
}
