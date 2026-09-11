import { join } from "node:path"
import { inspectCodexHookSources, repairCodexHookSources } from "../codex-hook-config.ts"
import { getHomeDirOrNull } from "../home.ts"

export const HOOK_REPAIR_COMMAND = "swiz manage hooks repair --codex"

function parseHookArgs(args: string[]): {
  action: "validate" | "repair"
  project: boolean
  dryRun: boolean
} {
  const action = args[0] ?? "validate"
  if (action !== "validate" && action !== "repair")
    throw new Error("Usage: swiz manage hooks <validate|repair> --codex [--project] [--dry-run]")
  for (const flag of args.slice(1)) {
    if (!["--codex", "--project", "--dry-run"].includes(flag))
      throw new Error(`Unsupported hooks option: ${flag}; only Codex is supported`)
  }
  return { action, project: args.includes("--project"), dryRun: args.includes("--dry-run") }
}

function resolveHookDirectory(project: boolean, options: { home?: string; cwd?: string }): string {
  const base = project ? (options.cwd ?? process.cwd()) : (options.home ?? getHomeDirOrNull())
  if (!base) throw new Error("HOME is not set; cannot locate Codex configuration")
  return join(base, ".codex")
}

export async function manageHooks(
  args: string[],
  options: { home?: string; cwd?: string } = {}
): Promise<string> {
  const { action, project, dryRun } = parseHookArgs(args)
  const directory = resolveHookDirectory(project, options)
  if (action === "validate") {
    const sources = await inspectCodexHookSources(directory)
    if (sources.conflict)
      throw new Error(
        `Codex hook definitions use both ${sources.hooksPath} and ${sources.configPath}. Run: ${HOOK_REPAIR_COMMAND}${project ? " --project" : ""}`
      )
    return `Codex hook sources are valid (${directory}).`
  }
  const result = await repairCodexHookSources(directory, { dryRun })
  if (!result.changed)
    return `Codex hook sources already use one representation (${directory}); no changes.`
  return [
    `${dryRun ? "Would move" : "Moved"} ${result.moved} hook handler(s) from config.toml into hooks.json.`,
    ...result.paths.map((path) => `${dryRun ? "Would back up" : "Backed up"}: ${path}.bak`),
    "Existing JSON hooks, unrelated settings, and trust records are retained.",
    dryRun
      ? "No files changed."
      : "Reload Codex. Moved hooks may need approval for their new source IDs.",
  ].join("\n")
}
