import { join } from "node:path"
import { inspectCodexHookSources } from "../../../codex-hook-config.ts"
import { getHomeDirOrNull } from "../../../home.ts"
import { HOOK_REPAIR_COMMAND } from "../../manage-hooks.ts"
import type { CheckResult, DiagnosticCheck } from "../types.ts"

export function codexHookDirectories(): string[] {
  const home = getHomeDirOrNull()
  return [...new Set([...(home ? [join(home, ".codex")] : []), join(process.cwd(), ".codex")])]
}

export function codexHookCheckName(directory: string): string {
  return `Codex hook sources (${directory})`
}

export async function checkCodexHookSources(directory: string): Promise<CheckResult> {
  const name = codexHookCheckName(directory)
  try {
    const source = await inspectCodexHookSources(directory)
    if (source.conflict) {
      const home = getHomeDirOrNull()
      const project = !home || directory !== join(home, ".codex")
      return {
        name,
        status: "warn",
        detail: `Hook definitions in both ${source.hooksPath} and ${source.configPath}; run: ${HOOK_REPAIR_COMMAND}${project ? " --project" : ""}, or swiz doctor --fix (preserves custom hooks; creates backups)`,
      }
    }
    return { name, status: "pass", detail: "No conflicting hook representations" }
  } catch (error) {
    return { name, status: "fail", detail: error instanceof Error ? error.message : String(error) }
  }
}

export const codexHookSourcesCheck: DiagnosticCheck = {
  name: "codex-hook-sources",
  async run() {
    return await Promise.all(codexHookDirectories().map(checkCodexHookSources))
  },
}
