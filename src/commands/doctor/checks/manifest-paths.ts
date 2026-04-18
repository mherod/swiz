import { join } from "node:path"
import { isInlineHookDef, manifest } from "../../../manifest.ts"
import { HOOKS_DIR } from "../../../swiz-hook-commands.ts"
import type { CheckResult, DiagnosticCheck } from "../types.ts"

/** Validate that every handler path referenced in the manifest resolves to an existing file. */
async function checkManifestHandlerPaths(): Promise<CheckResult> {
  const hookFiles = [
    ...new Set(
      manifest.flatMap((g) => g.hooks.flatMap((h) => (isInlineHookDef(h) ? [] : [h.file])))
    ),
  ]

  if (hookFiles.length === 0) {
    return {
      name: "Manifest handler paths",
      status: "pass",
      detail: `no handler files in manifest (hooks root: ${HOOKS_DIR})`,
    }
  }

  const missing: string[] = []
  for (const file of hookFiles) {
    const abs = join(HOOKS_DIR, file)
    if (!(await Bun.file(abs).exists())) {
      missing.push(file)
    }
  }

  if (missing.length === 0) {
    return {
      name: "Manifest handler paths",
      status: "pass",
      detail: `all ${hookFiles.length} handler paths valid (hooks root: ${HOOKS_DIR})`,
    }
  }

  return {
    name: "Manifest handler paths",
    status: "fail",
    detail: `${missing.length} missing handler paths: ${missing.join(", ")}`,
  }
}

export const manifestPathsCheck: DiagnosticCheck = {
  name: "manifest-paths",
  run: () => checkManifestHandlerPaths().then((r) => [r]),
}
