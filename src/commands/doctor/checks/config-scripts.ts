import { stat } from "node:fs/promises"
import type { CheckResult, DiagnosticCheck } from "../types.ts"
import { buildScriptPathSourceMap } from "./shared-scripts.ts"

async function checkInstalledConfigScripts(): Promise<CheckResult> {
  const pathSource = await buildScriptPathSourceMap()
  const missing: string[] = []
  const notExecutable: string[] = []

  for (const [scriptPath, source] of pathSource) {
    const label = `${scriptPath} (${source})`
    if (!(await Bun.file(scriptPath).exists())) {
      missing.push(label)
      continue
    }
    try {
      const s = await stat(scriptPath)
      if ((s.mode & 0o100) === 0) notExecutable.push(label)
    } catch {
      missing.push(label)
    }
  }

  if (missing.length === 0 && notExecutable.length === 0) {
    return {
      name: "Installed config scripts",
      status: "pass",
      detail: `all ${pathSource.size} executable scripts are present and executable`,
    }
  }

  const details: string[] = []
  if (missing.length > 0) {
    details.push(`${missing.length} missing: ${missing.join(", ")}`)
  }
  if (notExecutable.length > 0) {
    details.push(`${notExecutable.length} not executable: ${notExecutable.join(", ")}`)
  }
  return {
    name: "Installed config scripts",
    status: "fail",
    detail: details.join("; "),
  }
}

export const configScriptsCheck: DiagnosticCheck = {
  name: "config-scripts",
  run: () => checkInstalledConfigScripts().then((r) => [r]),
}
