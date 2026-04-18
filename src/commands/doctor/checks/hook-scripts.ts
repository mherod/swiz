import { join } from "node:path"
import { isInlineHookDef, manifest } from "../../../manifest.ts"
import { HOOKS_DIR } from "../../../swiz-hook-commands.ts"
import type { CheckResult, DiagnosticCheck } from "../types.ts"

async function checkHookScripts(): Promise<CheckResult> {
  const allFiles = new Set<string>()
  for (const group of manifest) {
    for (const hook of group.hooks) {
      if (isInlineHookDef(hook)) continue
      allFiles.add(hook.file)
    }
  }

  const missing: string[] = []
  for (const file of allFiles) {
    const path = join(HOOKS_DIR, file)
    if (!(await Bun.file(path).exists())) {
      missing.push(file)
    }
  }

  if (missing.length === 0) {
    return {
      name: "Hook scripts",
      status: "pass",
      detail: `all ${allFiles.size} manifest scripts found in hooks/`,
    }
  }

  return {
    name: "Hook scripts",
    status: "fail",
    detail: `${missing.length} missing: ${missing.join(", ")}`,
  }
}

export const hookScriptsCheck: DiagnosticCheck = {
  name: "hook-scripts",
  run: () => checkHookScripts().then((r) => [r]),
}
